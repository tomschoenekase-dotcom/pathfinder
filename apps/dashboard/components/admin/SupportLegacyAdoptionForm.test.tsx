/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  create: vi.fn(),
  client: {
    admin: {
      prepareLegacyKnowledgeAdoptionDraft: { query: vi.fn() },
      createSupportLegacyKnowledgeAdoptionDraft: { mutate: vi.fn() },
    },
  },
}))
mocks.client.admin.prepareLegacyKnowledgeAdoptionDraft.query = mocks.prepare
mocks.client.admin.createSupportLegacyKnowledgeAdoptionDraft.mutate = mocks.create
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))

import { SupportLegacyAdoptionForm } from './SupportLegacyAdoptionForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const desired = {
  title: 'Willow gallery hours',
  category: 'Hours',
  content: 'The Willow gallery closes at 6 PM.',
  isEnabled: true,
}
const props = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  proposalId: '11111111-1111-4111-8111-111111111111',
  proposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  expectedPreviewHash: 'a'.repeat(64),
  relation: 'CORRECTS' as const,
  desired,
  onFrozenChange: vi.fn(),
}
const prepared = {
  tenantId: props.tenantId,
  venueId: props.venueId,
  proposalId: props.proposalId,
  legacyKnowledgeEntryId: 'legacy-hours',
  expectedProposalUpdatedAt: props.proposalUpdatedAt,
  expectedPreviewHash: props.expectedPreviewHash,
  expectedLegacyUpdatedAt: '2026-09-10T11:00:00.000Z',
  expectedLegacySnapshotHash: 'b'.repeat(64),
  relation: props.relation,
  desired,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}

async function prepareForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Prepare private draft' }))
  await waitFor(() => expect(screen.getByLabelText('Content type')).toBeTruthy())
}

describe('SupportLegacyAdoptionForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prepare.mockResolvedValue(prepared)
    mocks.create.mockResolvedValue({
      moduleId: 'module-1',
      revisionId: 'revision-1',
      version: 1,
      requiresExplicitPublication: true,
      autoPublished: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('prepares explicitly and has no default content kind or publication action', async () => {
    render(<SupportLegacyAdoptionForm {...props} />)
    expect(screen.queryByLabelText('Content type')).toBeNull()
    await prepareForm()
    expect((screen.getByLabelText('Content type') as HTMLSelectElement).value).toBe('')
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull()
    expect(mocks.prepare).toHaveBeenCalledWith(
      {
        tenantId: props.tenantId,
        venueId: props.venueId,
        proposalId: props.proposalId,
        expectedUpdatedAt: new Date(props.proposalUpdatedAt),
        relation: props.relation,
        desired,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('maps immutable desired text into the selected typed payload', async () => {
    render(<SupportLegacyAdoptionForm {...props} />)
    await prepareForm()
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'ITEM' } })
    fireEvent.change(screen.getByLabelText('Item type'), { target: { value: 'Visitor policy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create private draft' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create.mock.calls[0]![0]).toEqual({
      ...prepared,
      draft: {
        audience: 'PUBLIC',
        evidence: [],
        payload: {
          kind: 'ITEM',
          name: desired.title,
          description: desired.content,
          itemType: 'Visitor policy',
        },
      },
    })
    expect(screen.getByText(/Publication still requires a separate explicit action/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review private content' }).getAttribute('href')).toBe(
      '/admin/clients/tenant-1/venues/venue-1/content',
    )
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull()
  })

  it('requires a valid event interval before creating a draft', async () => {
    render(<SupportLegacyAdoptionForm {...props} />)
    await prepareForm()
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'EVENT' } })
    fireEvent.change(screen.getByLabelText('Event starts (your local time)'), {
      target: { value: '2026-09-12T15:00' },
    })
    fireEvent.change(screen.getByLabelText('Event ends (optional, your local time)'), {
      target: { value: '2026-09-12T14:00' },
    })
    expect(
      (screen.getByRole('button', { name: 'Create private draft' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Create private draft' }))
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('treats a known rejection as requiring fresh preparation', async () => {
    mocks.create.mockRejectedValueOnce({ data: { code: 'BAD_REQUEST' } })
    render(<SupportLegacyAdoptionForm {...props} />)
    await prepareForm()
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'POLICY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create private draft' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Prepare private draft' })).toBeTruthy(),
    )
    expect(screen.queryByRole('button', { name: 'Retry exact private draft' })).toBeNull()
    expect(props.onFrozenChange).toHaveBeenCalledWith(false)
  })

  it('retains the exact frozen request after an unknown timeout', async () => {
    vi.useFakeTimers()
    const held = deferred<never>()
    mocks.create.mockReturnValueOnce(held.promise).mockResolvedValueOnce({
      moduleId: 'module-1',
      revisionId: 'revision-1',
      version: 1,
    })
    render(<SupportLegacyAdoptionForm {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare private draft' }))
    await act(async () => Promise.resolve())
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'POLICY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create private draft' }))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(screen.getByRole('button', { name: 'Retry exact private draft' })).toBeTruthy()
    const frozen = structuredClone(mocks.create.mock.calls[0]![0])
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact private draft' }))
    await act(async () => Promise.resolve())
    expect(mocks.create.mock.calls[1]![0]).toEqual(frozen)
    expect(props.onFrozenChange).toHaveBeenCalledWith(true)
  })

  it('discards late preparation from an obsolete proposal scope', async () => {
    const late = deferred<typeof prepared>()
    mocks.prepare.mockReturnValueOnce(late.promise)
    const view = render(<SupportLegacyAdoptionForm {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare private draft' }))
    view.rerender(
      <SupportLegacyAdoptionForm
        {...props}
        proposalId="22222222-2222-4222-8222-222222222222"
        expectedPreviewHash={'c'.repeat(64)}
      />,
    )
    await act(async () => late.resolve(prepared))
    expect(screen.queryByLabelText('Content type')).toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
