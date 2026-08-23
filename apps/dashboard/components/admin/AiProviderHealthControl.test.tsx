/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { setAiProviderHealthOverride: { mutate: mocks.mutate } } }),
}))

import { AiProviderHealthControl } from './AiProviderHealthControl'

const initialState = {
  overrides: [],
  activeUnhealthyProviders: [],
  configured: false,
  malformed: false,
  updatedAt: null,
  updatedBy: null,
}

function result(
  overrides: Array<{
    provider: 'anthropic' | 'openai'
    reason: string
    expiresAt: Date
    active: boolean
  }>,
) {
  return {
    schemaVersion: 1,
    overrides,
    activeUnhealthyProviders: overrides.filter((item) => item.active).map((item) => item.provider),
    configured: true,
    malformed: false,
    updatedAt: new Date('2026-08-22T20:01:00.000Z'),
    updatedBy: 'admin_1',
  }
}

describe('AiProviderHealthControl', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('shows eligible defaults and requires both reason and explicit expiry to exclude', () => {
    render(<AiProviderHealthControl initialState={initialState} />)
    expect(screen.getAllByText('Eligible')).toHaveLength(2)
    expect(
      (screen.getByRole('button', { name: 'Exclude until expiry' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: 'Provider incident' },
    })
    expect(
      (screen.getByRole('button', { name: 'Exclude until expiry' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('writes an expiring exclusion against the exact rendered revision', async () => {
    const expiry = new Date('2099-08-23T20:00:00.000Z')
    mocks.mutate.mockResolvedValueOnce(
      result([
        { provider: 'anthropic', reason: 'Provider incident', expiresAt: expiry, active: true },
      ]),
    )
    render(
      <AiProviderHealthControl
        initialState={{
          ...initialState,
          configured: true,
          updatedAt: '2026-08-22T20:00:00.000Z',
          updatedBy: 'admin_0',
        }}
      />,
    )
    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: '  Provider incident  ' },
    })
    fireEvent.change(screen.getByLabelText('Exclusion expiry'), {
      target: { value: '2099-08-23T20:00' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Exclude until expiry' }))

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        provider: 'anthropic',
        unhealthy: true,
        reason: 'Provider incident',
        expiresAt: new Date('2099-08-23T20:00'),
        expectedUpdatedAt: new Date('2026-08-22T20:00:00.000Z'),
      }),
    )
    expect(await screen.findByText('Excluded')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('restores only the selected provider and clears expiry in the action', async () => {
    mocks.mutate.mockResolvedValueOnce(result([]))
    render(<AiProviderHealthControl initialState={initialState} />)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText('Internal reason'), {
      target: { value: 'Provider recovered' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected provider' }))
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        provider: 'openai',
        unhealthy: false,
        reason: 'Provider recovered',
        expiresAt: null,
        expectedUpdatedAt: null,
      }),
    )
  })

  it('renders malformed control as fail-closed and exposes reviewed repair actions', () => {
    render(
      <AiProviderHealthControl
        initialState={{
          ...initialState,
          configured: true,
          malformed: true,
          updatedAt: '2026-08-22T20:00:00.000Z',
        }}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('fail-closed')
    expect(screen.getByRole('button', { name: 'Restore selected provider' })).toBeTruthy()
  })

  it('uses structured conflict guidance without exposing server error text', async () => {
    mocks.mutate.mockRejectedValueOnce(
      Object.assign(new Error('private provider details'), { data: { code: 'CONFLICT' } }),
    )
    render(<AiProviderHealthControl initialState={initialState} />)
    fireEvent.change(screen.getByLabelText('Internal reason'), { target: { value: 'Recovered' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected provider' }))
    expect((await screen.findByRole('alert')).textContent).toContain('changed in another session')
    expect(screen.getByRole('alert').textContent).not.toContain('private provider details')
  })

  it('has no automated accessibility violations in its mobile-ready control surface', async () => {
    const { container } = render(<AiProviderHealthControl initialState={initialState} />)
    document.documentElement.lang = 'en'
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })
})
