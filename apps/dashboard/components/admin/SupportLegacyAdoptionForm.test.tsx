/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  create: vi.fn(),
  authoring: vi.fn(),
  createUniversal: vi.fn(),
  client: {
    admin: {
      getSupportProposalAuthoringState: { query: vi.fn() },
      prepareLegacyKnowledgeAdoptionDraft: { query: vi.fn() },
      createSupportLegacyKnowledgeAdoptionDraft: { mutate: vi.fn() },
      createSupportSemanticUniversalContentDraft: { mutate: vi.fn() },
    },
  },
}))
mocks.client.admin.prepareLegacyKnowledgeAdoptionDraft.query = mocks.prepare
mocks.client.admin.createSupportLegacyKnowledgeAdoptionDraft.mutate = mocks.create
mocks.client.admin.getSupportProposalAuthoringState.query = mocks.authoring
mocks.client.admin.createSupportSemanticUniversalContentDraft.mutate = mocks.createUniversal
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
    mocks.authoring.mockResolvedValue({ state: 'LEGACY_UNADOPTED' })
    mocks.create.mockResolvedValue({
      moduleId: 'module-1',
      revisionId: 'revision-1',
      version: 1,
      requiresExplicitPublication: true,
      autoPublished: false,
    })
    mocks.createUniversal.mockResolvedValue({
      moduleId: 'module-1',
      revisionId: 'revision-1',
      version: 1,
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
    expect(mocks.authoring).toHaveBeenCalledWith(
      {
        tenantId: props.tenantId,
        venueId: props.venueId,
        proposalId: props.proposalId,
        expectedUpdatedAt: new Date(props.proposalUpdatedAt),
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
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
    mocks.authoring.mockResolvedValueOnce({ state: 'NO_TARGET', proposalStatus: 'APPROVED' })
    mocks.createUniversal.mockReturnValueOnce(held.promise).mockResolvedValueOnce({
      moduleId: 'module-1',
      revisionId: 'revision-1',
      version: 1,
    })
    render(<SupportLegacyAdoptionForm {...props} relation="NEW_FACT" />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare private draft' }))
    await act(async () => Promise.resolve())
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'POLICY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create private draft' }))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(screen.getByRole('button', { name: 'Retry exact private draft' })).toBeTruthy()
    const frozen = structuredClone(mocks.createUniversal.mock.calls[0]![0])
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact private draft' }))
    await act(async () => Promise.resolve())
    expect(mocks.createUniversal.mock.calls[1]![0]).toEqual(frozen)
    expect(props.onFrozenChange).toHaveBeenCalledWith(true)
  })

  it('discards late preparation from an obsolete proposal scope', async () => {
    const late = deferred<{ state: 'LEGACY_UNADOPTED' }>()
    mocks.authoring.mockReturnValueOnce(late.promise)
    const view = render(<SupportLegacyAdoptionForm {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare private draft' }))
    view.rerender(
      <SupportLegacyAdoptionForm
        {...props}
        proposalId="22222222-2222-4222-8222-222222222222"
        expectedPreviewHash={'c'.repeat(64)}
      />,
    )
    await act(async () => late.resolve({ state: 'LEGACY_UNADOPTED' }))
    expect(screen.queryByLabelText('Content type')).toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('creates an untargeted addition through the universal route', async () => {
    mocks.authoring.mockResolvedValueOnce({ state: 'NO_TARGET', proposalStatus: 'APPROVED' })
    render(<SupportLegacyAdoptionForm {...props} relation="NEW_FACT" />)
    await prepareForm()
    fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'POLICY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create private draft' }))
    await waitFor(() => expect(mocks.createUniversal).toHaveBeenCalledOnce())
    expect(mocks.createUniversal.mock.calls[0]![0]).toEqual({
      tenantId: props.tenantId,
      venueId: props.venueId,
      proposalId: props.proposalId,
      expectedProposalUpdatedAt: props.proposalUpdatedAt,
      expectedPreviewHash: props.expectedPreviewHash,
      relation: 'NEW_FACT',
      desired,
      draft: {
        audience: 'PUBLIC',
        evidence: [],
        payload: { kind: 'POLICY', title: desired.title, rule: desired.content, appliesTo: [] },
      },
    })
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('locks a native correction to its existing supported content kind', async () => {
    mocks.authoring.mockResolvedValueOnce({
      state: 'NATIVE_READY',
      moduleId: 'module-1',
      moduleKind: 'POLICY',
      expectedBaseRevisionId: 'revision-1',
      expectedBaseVersion: 1,
      publicationId: 'publication-1',
    })
    render(<SupportLegacyAdoptionForm {...props} />)
    await prepareForm()
    const kind = screen.getByLabelText('Content type') as HTMLSelectElement
    expect(kind.value).toBe('POLICY')
    expect(kind.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Create private draft' }))
    await waitFor(() => expect(mocks.createUniversal).toHaveBeenCalledOnce())
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('shows an own receipt and blocks unavailable or privately adopted targets', async () => {
    mocks.authoring.mockResolvedValueOnce({
      state: 'OWN_UNIVERSAL_RECEIPT',
      moduleId: 'module-1',
      revisionId: 'revision-1',
      moduleKind: 'POLICY',
      latestRevision: { id: 'revision-2', version: 2 },
      latestPublication: { id: 'publication-2', revisionId: 'revision-2', action: 'WITHDRAW' },
    })
    const view = render(<SupportLegacyAdoptionForm {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare private draft' }))
    await waitFor(() => expect(screen.getByText('Existing content revision')).toBeTruthy())
    expect(screen.getByText('Existing content revision')).toBeTruthy()
    expect(screen.getByText(/latest publication action is withdrawn/)).toBeTruthy()
    expect(screen.queryByLabelText('Content type')).toBeNull()

    mocks.authoring.mockResolvedValueOnce({ state: 'OTHER_ADOPTION_DRAFT' })
    view.rerender(
      <SupportLegacyAdoptionForm {...props} proposalId="22222222-2222-4222-8222-222222222222" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Prepare private draft' }))
    await waitFor(() => expect(screen.getByText(/Another proposal already has/)).toBeTruthy())
    expect(screen.getByRole('link', { name: 'Review private content' })).toBeTruthy()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.createUniversal).not.toHaveBeenCalled()
  })

  it('treats an existing duplicate review as terminal without claiming fulfillment', async () => {
    mocks.authoring.mockResolvedValueOnce({
      state: 'OWN_DUPLICATE_RESOLUTION',
      resolutionId: 'resolution-1',
      outcome: 'DUPLICATE_NOOP',
      targetKnowledgeEntryId: 'entry-1',
      relation: 'CORRECTS',
      createdAt: new Date('2026-09-10T12:00:00.000Z'),
      proposalRevisionCurrent: true,
      currentFulfillmentVerified: false,
    })
    render(<SupportLegacyAdoptionForm {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare private draft' }))
    expect(await screen.findByText(/already has a duplicate review receipt/)).toBeTruthy()
    expect(screen.getByText(/does not verify current fulfillment/)).toBeTruthy()
    expect(screen.queryByLabelText('Content type')).toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.createUniversal).not.toHaveBeenCalled()
  })
})
