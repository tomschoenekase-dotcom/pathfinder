/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const mutate = vi.fn()
const mutateOperational = vi.fn()
const mutateQuestion = vi.fn()
const resolveConflict = vi.fn()
const listTemporalEvidence = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      previewSemanticVenueUpdate: { query },
      createSemanticVenueUpdatePackageDraft: { mutate },
      createSemanticOperationalUpdateDraft: { mutate: mutateOperational },
      resolveSemanticConflict: { mutate: resolveConflict },
      createSemanticConflictQuestion: { mutate: mutateQuestion },
      listKnowledgeProposalTemporalEvidence: { query: listTemporalEvidence },
    },
  }),
}))

import { SemanticUpdatePreview } from './SemanticUpdatePreview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('SemanticUpdatePreview', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  function temporalEvidence(key = 'review:closure') {
    return {
      key,
      reference: {
        reviewReceiptId: '11111111-1111-4111-8111-111111111112',
        expectedSnapshotHash: 'e'.repeat(64),
        claimId: 'east-gallery-closure',
      },
      desired: {
        title: 'East gallery closure',
        category: 'access',
        content: 'The east gallery is temporarily closed.',
        isEnabled: true,
      },
      validFrom: '2030-01-01T08:00:00.123Z',
      validUntil: '2030-01-01T12:00:00.456Z',
      reviewedAt: '2029-12-31T16:00:00.000Z',
      sourceNames: ['closure-notice.png', 'second-notice.png'],
    }
  }

  it('drops reviewed source selection when the review form is closed', async () => {
    listTemporalEvidence.mockResolvedValue({
      items: [temporalEvidence()],
      nextCursor: null,
      requiresTemporalEvidence: true,
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    fireEvent.click(await screen.findByRole('button', { name: 'Use reviewed source' }))
    expect(screen.getByRole('button', { name: 'Reviewed source selected' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    expect(await screen.findByRole('button', { name: 'Use reviewed source' })).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Compute semantic preview' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('computes and renders one correction without publication controls', async () => {
    query.mockResolvedValue({
      classification: 'CORRECTION',
      operationCount: 1,
      authority: 'TRUSTED_PARTNER',
      confidence: 0.95,
      blockers: [],
      questions: [],
      proposalStatus: 'APPROVED',
      previewHash: 'a'.repeat(64),
      venuePackagePatch: { schemaVersion: 3 },
    })
    mutate.mockResolvedValue({ packageId: 'package-a', packageStatus: 'DRAFT', replayed: false })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'HOURS' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Museum hours' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 9–5 daily.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))

    expect(await screen.findByText('CORRECTION')).toBeTruthy()
    expect(screen.getByText('1 proposed operation')).toBeTruthy()
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        relation: 'CORRECTS',
        desired: expect.objectContaining({ content: 'Open 9–5 daily.' }),
      }),
      { signal: expect.any(AbortSignal) },
    )
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create reviewable package DRAFT' }))
    expect(await screen.findByText(/Created DRAFT/)).toBeTruthy()
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPreviewHash: 'a'.repeat(64),
        relation: 'CORRECTS',
      }),
    )
    expect(screen.getByRole('link', { name: 'Open package review' }).getAttribute('href')).toBe(
      '/admin/clients/tenant-a/venues/venue-a/packages',
    )
  })

  it('invalidates a computed preview when structured content changes', async () => {
    query.mockResolvedValue({
      classification: 'CORRECTION',
      operationCount: 1,
      authority: 'TRUSTED_PARTNER',
      confidence: 0.95,
      blockers: [],
      questions: [],
      proposalStatus: 'APPROVED',
      previewHash: 'a'.repeat(64),
      venuePackagePatch: { schemaVersion: 3 },
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'HOURS' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Museum hours' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 9–5 daily.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))
    expect(
      await screen.findByRole('button', { name: 'Create reviewable package DRAFT' }),
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 10–6 daily.' },
    })
    expect(screen.queryByRole('button', { name: 'Create reviewable package DRAFT' })).toBeNull()
  })

  it('creates a separate inactive operational DRAFT for a temporal preview', async () => {
    listTemporalEvidence.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      requiresTemporalEvidence: false,
    })
    query.mockResolvedValue({
      classification: 'TEMPORAL',
      operationCount: 1,
      authority: 'TRUSTED_PARTNER',
      confidence: 0.95,
      blockers: [],
      questions: [],
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      venuePackagePatch: null,
      operationalUpdateDraft: { status: 'DRAFT' },
    })
    mutateOperational.mockResolvedValue({
      operationalUpdateId: 'update-a',
      operationalUpdateStatus: 'DRAFT',
      replayed: false,
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'TEMPORARY_CLOSURE' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Atrium closure' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Closed for maintenance.' },
    })
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    fireEvent.change(screen.getByLabelText('Starts at'), {
      target: { value: '2030-01-01T08:00' },
    })
    fireEvent.change(screen.getByLabelText('Expires at'), {
      target: { value: '2030-01-01T12:00' },
    })
    fireEvent.change(screen.getByLabelText('Operational update type'), {
      target: { value: 'TEMPORARY_CLOSURE' },
    })
    await screen.findByText(
      'No current dated sources appear on this review page. Check an earlier reviewed page if one is available.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))

    expect(await screen.findByText('TEMPORAL')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create operational update DRAFT' }))
    expect(await screen.findByText(/Created DRAFT/)).toBeTruthy()
    expect(mutateOperational).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPreviewHash: 'b'.repeat(64),
        operationalUpdateType: 'TEMPORARY_CLOSURE',
        validFrom: new Date('2030-01-01T08:00').toISOString(),
        validUntil: new Date('2030-01-01T12:00').toISOString(),
      }),
    )
    expect(screen.queryByRole('button', { name: /schedule|publish/i })).toBeNull()
  })

  it('persists a conflict as one blocking operator question without execution authority', async () => {
    query.mockResolvedValue({
      classification: 'CONFLICT',
      operationCount: 0,
      authority: 'PUBLIC_SECONDARY',
      confidence: 0.78,
      blockers: [
        {
          code: 'LOWER_AUTHORITY_CONFLICT',
          path: 'evidence',
          message: 'Lower-authority evidence requires clarification.',
        },
      ],
      questions: [
        {
          owner: 'VENUE_OPERATOR',
          prompt: 'Which hours information should visitors receive for “Museum hours”?',
          blockerCodes: ['LOWER_AUTHORITY_CONFLICT'],
        },
      ],
      proposalStatus: 'APPROVED',
      previewHash: 'c'.repeat(64),
      venuePackagePatch: null,
      operationalUpdateDraft: null,
      conflictQuestion: null,
      questionAgentIdentities: [
        { id: 'content-agent-1', identityKey: 'content.steward', name: 'Content Steward' },
      ],
    })
    mutateQuestion.mockResolvedValue({
      questionId: 'question-1',
      questionStatus: 'PENDING',
      replayed: false,
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'HOURS' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Museum hours' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 10–6 daily.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))

    expect(await screen.findByText('CONFLICT')).toBeTruthy()
    expect(screen.getByLabelText('Content identity')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create blocking operator question' }))
    expect(await screen.findByText(/Existing question is PENDING/)).toBeTruthy()
    expect(mutateQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPreviewHash: 'c'.repeat(64),
        agentIdentityId: 'content-agent-1',
      }),
    )
    expect(
      screen.getByText(/grants no approval, apply, scheduling, or publication authority/),
    ).toBeTruthy()
  })

  it('aborts a stalled semantic preview and returns fixed retry guidance at the deadline', async () => {
    vi.useFakeTimers()
    query.mockImplementation(() => new Promise(() => {}))
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'HOURS' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Museum hours' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 9–5 daily.' },
    })
    const compute = screen.getByRole('button', { name: 'Compute semantic preview' })
    fireEvent.click(compute)
    fireEvent.click(compute)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(query).toHaveBeenCalledOnce()
    const signal = query.mock.calls[0]?.[1]?.signal as AbortSignal

    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('Semantic preview could not be loaded')
    expect(
      (screen.getByRole('button', { name: 'Compute semantic preview' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('aborts an in-flight preview when structured input changes', async () => {
    let signal: AbortSignal | undefined
    query.mockImplementation((_input, options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => {})
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'HOURS' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Museum hours' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 9–5 daily.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))
    await waitFor(() => expect(signal).toBeDefined())
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 10–6 daily.' },
    })
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByText(/Semantic preview could not/)).toBeNull()
  })

  it('forwards an exact selected reviewed source, including millisecond dates, to preview and DRAFT', async () => {
    const evidence = temporalEvidence()
    listTemporalEvidence.mockResolvedValue({
      items: [evidence],
      nextCursor: null,
      requiresTemporalEvidence: true,
    })
    query.mockResolvedValue({
      classification: 'TEMPORAL',
      operationCount: 1,
      authority: 'PUBLIC_SECONDARY',
      confidence: 0.8,
      blockers: [],
      questions: [],
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      venuePackagePatch: null,
      operationalUpdateDraft: { status: 'DRAFT' },
    })
    mutateOperational.mockResolvedValue({
      operationalUpdateId: 'update-a',
      operationalUpdateStatus: 'DRAFT',
      replayed: false,
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    expect(await screen.findByText('East gallery closure')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Compute semantic preview' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Use reviewed source' }))
    expect((screen.getByLabelText('Visitor-facing title') as HTMLInputElement).value).toBe(
      evidence.desired.title,
    )
    expect((screen.getByLabelText('Visitor-facing content') as HTMLTextAreaElement).value).toBe(
      evidence.desired.content,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))
    await screen.findByText('TEMPORAL')
    expect(query).toHaveBeenLastCalledWith(
      expect.objectContaining({
        temporalEvidence: evidence.reference,
        validFrom: evidence.validFrom,
        validUntil: evidence.validUntil,
        desired: evidence.desired,
      }),
      { signal: expect.any(AbortSignal) },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create operational update DRAFT' }))
    await screen.findByText(/Created DRAFT/)
    expect(mutateOperational).toHaveBeenCalledWith(
      expect.objectContaining({
        temporalEvidence: evidence.reference,
        validFrom: evidence.validFrom,
        validUntil: evidence.validUntil,
      }),
    )
  })

  it('clears a selected reviewed source when bound text is edited', async () => {
    listTemporalEvidence.mockResolvedValue({
      items: [temporalEvidence()],
      nextCursor: null,
      requiresTemporalEvidence: true,
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    await screen.findByText('East gallery closure')
    fireEvent.click(screen.getByRole('button', { name: 'Use reviewed source' }))
    expect(screen.getByRole('button', { name: 'Reviewed source selected' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Edited closure.' },
    })
    expect(screen.getByRole('button', { name: 'Use reviewed source' })).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Compute semantic preview' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('shows a bounded next page without retaining earlier choices', async () => {
    const first = temporalEvidence('first')
    const second = temporalEvidence('second')
    listTemporalEvidence
      .mockResolvedValueOnce({
        items: [first],
        nextCursor: {
          receiptId: first.reference.reviewReceiptId,
          createdAt: '2030-01-01T00:00:00.000Z',
          claimOffset: 1,
        },
        requiresTemporalEvidence: false,
      })
      .mockResolvedValueOnce({ items: [second], nextCursor: null, requiresTemporalEvidence: false })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    await screen.findByText('East gallery closure')
    fireEvent.click(screen.getByRole('button', { name: 'Load next sources' }))
    await waitFor(() => expect(listTemporalEvidence).toHaveBeenCalledTimes(2))
    expect(listTemporalEvidence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: {
          receiptId: first.reference.reviewReceiptId,
          createdAt: '2030-01-01T00:00:00.000Z',
          claimOffset: 1,
        },
      }),
      { signal: expect.any(AbortSignal) },
    )
    expect(screen.getAllByText('East gallery closure')).toHaveLength(1)
  })

  it('keeps temporal discovery errors and empty results explicit', async () => {
    listTemporalEvidence.mockRejectedValueOnce(new Error('Current review changed.'))
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    expect((await screen.findByRole('alert')).textContent).toContain('Current review changed.')
    listTemporalEvidence.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      requiresTemporalEvidence: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }))
    expect(
      await screen.findByText(
        'No current dated sources appear on this review page. Check an earlier reviewed page if one is available.',
      ),
    ).toBeTruthy()
  })

  it('clears an invisible selection when refresh returns an empty current page', async () => {
    listTemporalEvidence
      .mockResolvedValueOnce({
        items: [temporalEvidence()],
        nextCursor: null,
        requiresTemporalEvidence: true,
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null, requiresTemporalEvidence: true })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    await screen.findByText('East gallery closure')
    fireEvent.click(screen.getByRole('button', { name: 'Use reviewed source' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }))
    await screen.findByText(
      'No current dated sources appear on this review page. Check an earlier reviewed page if one is available.',
    )
    expect(
      (screen.getByRole('button', { name: 'Compute semantic preview' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('does not attach a late operational DRAFT result to a replacement scope', async () => {
    let resolveDraft: ((value: unknown) => void) | undefined
    listTemporalEvidence.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      requiresTemporalEvidence: false,
    })
    query.mockResolvedValue({
      classification: 'TEMPORAL',
      operationCount: 1,
      authority: 'PUBLIC_SECONDARY',
      confidence: 0.8,
      blockers: [],
      questions: [],
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      venuePackagePatch: null,
      operationalUpdateDraft: { status: 'DRAFT' },
    })
    mutateOperational.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDraft = resolve
        }),
    )
    const view = render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'access' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Closure' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Closed.' },
    })
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '2030-01-01T08:00' } })
    fireEvent.change(screen.getByLabelText('Expires at'), { target: { value: '2030-01-01T12:00' } })
    await screen.findByText(
      'No current dated sources appear on this review page. Check an earlier reviewed page if one is available.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))
    await screen.findByText('TEMPORAL')
    fireEvent.click(screen.getByRole('button', { name: 'Create operational update DRAFT' }))
    view.rerender(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-b"
        proposalId="22222222-2222-4222-8222-222222222222"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    resolveDraft?.({
      operationalUpdateId: 'old',
      operationalUpdateStatus: 'DRAFT',
      replayed: false,
    })
    await act(async () => {})
    expect(screen.queryByText(/Created DRAFT/)).toBeNull()
    expect(screen.queryByText(/could not be created/)).toBeNull()
  })

  it('does not render a late temporal listing after the proposal scope changes', async () => {
    let resolveOld: ((value: unknown) => void) | undefined
    const old = temporalEvidence('old')
    const fresh = {
      ...temporalEvidence('fresh'),
      desired: { ...temporalEvidence().desired, title: 'Current review closure' },
    }
    listTemporalEvidence
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValueOnce({ items: [fresh], nextCursor: null, requiresTemporalEvidence: false })
    const view = render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    expect(screen.getByText('Reading sources…')).toBeTruthy()
    await waitFor(() => expect(listTemporalEvidence).toHaveBeenCalledTimes(1))
    view.rerender(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-b"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    await waitFor(() => expect(listTemporalEvidence).toHaveBeenCalledTimes(2))
    resolveOld?.({ items: [old], nextCursor: null, requiresTemporalEvidence: true })
    await act(async () => {})
    expect(screen.queryByText(old.desired.title)).toBeNull()
    expect(await screen.findByText('Current review closure')).toBeTruthy()
  })
  it('refreshes a known conflict even when the evidence version is unchanged, then links the separately reviewed replacement', async () => {
    const snapshot = {
      classification: 'CONFLICT',
      operationCount: 0,
      authority: 'TRUSTED_PARTNER',
      confidence: 0.95,
      blockers: [{ code: 'LOWER_AUTHORITY_CONFLICT', message: 'Human-confirmed hours differ.' }],
      questions: [
        {
          owner: 'VENUE_OPERATOR',
          prompt: 'Which hours?',
          blockerCodes: ['LOWER_AUTHORITY_CONFLICT'],
        },
      ],
      proposalStatus: 'APPROVED',
      previewHash: 'a'.repeat(64),
      venuePackagePatch: null,
      operationalUpdateDraft: null,
      conflictQuestion: {
        id: 'question-1',
        status: 'ANSWERED',
        answer: 'Use the signed hours sheet.',
        updatedAt: '2026-09-10T12:00:00.000Z',
        answeredAt: '2026-09-10T12:00:00.000Z',
        answerHash: 'b'.repeat(64),
      },
      questionAgentIdentities: [],
    }
    query.mockResolvedValue(snapshot)
    resolveConflict.mockRejectedValueOnce({ data: { code: 'CONFLICT' } }).mockResolvedValueOnce({
      resolutionId: 'resolution-1',
      replacementProposalId: 'replacement-1',
      outcome: 'PROPOSE_REPLACEMENT',
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'hours' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Gallery hours' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Closes at 7 PM.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))
    fireEvent.click(await screen.findByLabelText(/Keep current guidance/))
    fireEvent.change(screen.getByLabelText('Resolution note'), {
      target: { value: 'Keep verified guidance.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record resolution' }))
    const refresh = await screen.findByRole('button', { name: 'Refresh conflict' })
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByLabelText('Visitor-facing title').closest('fieldset') as HTMLFieldSetElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(refresh)
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    expect((screen.getByLabelText(/Keep current guidance/) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByLabelText(/Propose replacement/))
    fireEvent.change(screen.getByLabelText('Replacement content'), {
      target: { value: 'Closes at 6 PM.' },
    })
    fireEvent.change(screen.getByLabelText('Resolution note'), {
      target: { value: 'Use signed sheet.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record resolution' }))
    const link = await screen.findByRole('link', { name: 'Review replacement proposal' })
    expect(link.getAttribute('href')).toBe(
      '/admin/clients/tenant-a/venues/venue-a/knowledge-proposals?review=replacement-1#proposal-replacement-1',
    )
    expect(screen.getByText('Replacement awaits review')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Compute semantic preview' })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
    expect(mutateOperational).not.toHaveBeenCalled()
  })
  it('restores and locks the saved resolution wording without carrying it into another scope', async () => {
    const desired = {
      title: 'Gallery access',
      category: 'ACCESS',
      content: 'Use the east door.',
      isEnabled: false,
    }
    query.mockResolvedValueOnce({
      classification: 'CORRECTION',
      operationCount: 1,
      authority: 'TRUSTED_PARTNER',
      confidence: 0.9,
      blockers: [],
      questions: [],
      proposalStatus: 'PENDING_REVIEW',
      venuePackagePatch: null,
      operationalUpdateDraft: null,
    })
    const props = {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      proposalId: '11111111-1111-4111-8111-111111111111',
      proposalUpdatedAt: '2026-09-10T12:00:00.000Z',
      hasTarget: true,
    }
    const view = render(
      <SemanticUpdatePreview {...props} resolutionDraft={{ desired, relation: 'SUPERSEDES' }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    expect((screen.getByLabelText('Visitor-facing title') as HTMLInputElement).value).toBe(
      desired.title,
    )
    expect((screen.getByLabelText('Change relationship') as HTMLSelectElement).value).toBe(
      'SUPERSEDES',
    )
    expect(
      (screen.getByLabelText('Visitor-facing title').closest('fieldset') as HTMLFieldSetElement)
        .disabled,
    ).toBe(true)
    expect(
      (screen.getByLabelText('Enabled in canonical knowledge') as HTMLInputElement).checked,
    ).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Compute semantic preview' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({ desired, relation: 'SUPERSEDES' }),
        expect.anything(),
      ),
    )
    expect(mutate).not.toHaveBeenCalled()
    view.rerender(<SemanticUpdatePreview {...props} tenantId="tenant-b" />)
    expect((screen.getByLabelText('Visitor-facing title') as HTMLInputElement).value).toBe('')
    expect(
      (screen.getByRole('button', { name: 'Compute semantic preview' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})
