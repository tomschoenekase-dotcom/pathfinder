/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { createNativeVenueDeployment: { mutate: mocks.create } } }),
}))

import { NativeVenueDeploymentCreateForm } from './NativeVenueDeploymentCreateForm'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('NativeVenueDeploymentCreateForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('records the exact unchanged manifest once across same-tick clicks', async () => {
    const pending = deferred<unknown>()
    mocks.create.mockReturnValue(pending.promise)
    render(<NativeVenueDeploymentCreateForm tenantId="tenant-1" venueId="venue-1" />)
    fireEvent.change(screen.getByLabelText('Native FULL manifest JSON'), {
      target: { value: '{"materializationProfile":"NATIVE_CORE_V1"}' },
    })
    const button = screen.getByRole('button', { name: 'Record native draft release' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      manifestJson: '{"materializationProfile":"NATIVE_CORE_V1"}',
    })
    await act(async () => pending.resolve({ profile: 'NATIVE_CORE_V1', status: 'DRAFT' }))
  })

  it('purges old input and ignores a late result on a render-synchronous venue change', async () => {
    const pending = deferred<unknown>()
    mocks.create.mockReturnValue(pending.promise)
    const { rerender } = render(
      <NativeVenueDeploymentCreateForm tenantId="tenant-1" venueId="venue-1" />,
    )
    fireEvent.change(screen.getByLabelText('Native FULL manifest JSON'), {
      target: { value: '{"old":true}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record native draft release' }))
    rerender(<NativeVenueDeploymentCreateForm tenantId="tenant-1" venueId="venue-2" />)
    expect((screen.getByLabelText('Native FULL manifest JSON') as HTMLTextAreaElement).value).toBe(
      '',
    )
    expect(
      (screen.getByRole('button', { name: 'Record native draft release' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await act(async () => pending.resolve({ profile: 'NATIVE_CORE_V1', status: 'DRAFT' }))
    expect(screen.queryByText(/Nothing was approved/)).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('uses a bounded message and preserves manifest text after an unknown failure', async () => {
    mocks.create.mockRejectedValue(new Error('postgres://secret/provider-internal'))
    render(<NativeVenueDeploymentCreateForm tenantId="tenant-1" venueId="venue-1" />)
    fireEvent.change(screen.getByLabelText('Native FULL manifest JSON'), {
      target: { value: '{"keep":true}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record native draft release' }))
    expect((await screen.findByRole('alert')).textContent).not.toContain('provider-internal')
    expect((screen.getByLabelText('Native FULL manifest JSON') as HTMLTextAreaElement).value).toBe(
      '{"keep":true}',
    )
  })
})
