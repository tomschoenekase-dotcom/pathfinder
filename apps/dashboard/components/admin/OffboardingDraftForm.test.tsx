/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { createOffboardingDraft: { mutate: mocks.mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { OffboardingDraftForm } from './OffboardingDraftForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('OffboardingDraftForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('requires explicit venue selection and acknowledgement', () => {
    render(
      <OffboardingDraftForm tenantId="tenant-1" venues={[{ id: 'venue-1', name: 'Museum' }]} />,
    )
    const submit = screen.getByRole('button', { name: 'Create requested draft' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Museum'))
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/I confirm this creates only/))
    expect((submit as HTMLButtonElement).disabled).toBe(false)
  })

  it('serializes one requested-draft mutation with every required revocation target', async () => {
    let resolve!: (value: { id: string }) => void
    mocks.mutate.mockReturnValue(
      new Promise<{ id: string }>((done) => {
        resolve = done
      }),
    )
    render(
      <OffboardingDraftForm tenantId="tenant-1" venues={[{ id: 'venue-1', name: 'Museum' }]} />,
    )
    fireEvent.click(screen.getByLabelText('Museum'))
    fireEvent.click(screen.getByLabelText(/I confirm this creates only/))
    const submit = screen.getByRole('button', { name: 'Create requested draft' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
      venueIds: ['venue-1'],
      revocationTargets: [
        'GUEST_LINKS',
        'WIDGETS',
        'PARTNER_API_KEYS',
        'MCP_CREDENTIALS',
        'BACKGROUND_JOBS',
        'AGENT_IDENTITIES',
        'CLIENT_ACCESS',
        'OPERATOR_IMPERSONATION',
      ],
      exportKinds: [],
    })
    resolve({ id: 'plan-1' })
    await waitFor(() =>
      expect(screen.getByText(/No access was revoked and no data was deleted/)).toBeTruthy(),
    )
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('retains the same request identity when an uncertain attempt is retried unchanged', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('Transport uncertain')).mockResolvedValueOnce({
      id: 'plan-1',
      replayed: true,
    })
    render(
      <OffboardingDraftForm tenantId="tenant-1" venues={[{ id: 'venue-1', name: 'Museum' }]} />,
    )
    fireEvent.click(screen.getByLabelText('Museum'))
    fireEvent.click(screen.getByLabelText(/I confirm this creates only/))
    fireEvent.click(screen.getByRole('button', { name: 'Create requested draft' }))
    await screen.findByText('Transport uncertain')
    const firstRequestId = mocks.mutate.mock.calls[0]?.[0]?.requestId

    fireEvent.click(screen.getByRole('button', { name: 'Create requested draft' }))
    await screen.findByText(/No access was revoked and no data was deleted/)
    expect(mocks.mutate.mock.calls[1]?.[0]?.requestId).toBe(firstRequestId)
  })

  it('reports a failed draft truthfully without claiming any action occurred', async () => {
    mocks.mutate.mockRejectedValue(new Error('Draft service unavailable'))
    render(
      <OffboardingDraftForm tenantId="tenant-1" venues={[{ id: 'venue-1', name: 'Museum' }]} />,
    )
    fireEvent.click(screen.getByLabelText('Museum'))
    fireEvent.click(screen.getByLabelText(/I confirm this creates only/))
    fireEvent.click(screen.getByRole('button', { name: 'Create requested draft' }))
    await waitFor(() => expect(screen.getByText('Draft service unavailable')).toBeTruthy())
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
