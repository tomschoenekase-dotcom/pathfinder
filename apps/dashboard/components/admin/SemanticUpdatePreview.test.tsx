/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const mutate = vi.fn()
const mutateOperational = vi.fn()
const mutateQuestion = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      previewSemanticVenueUpdate: { query },
      createSemanticVenueUpdatePackageDraft: { mutate },
      createSemanticOperationalUpdateDraft: { mutate: mutateOperational },
      createSemanticConflictQuestion: { mutate: mutateQuestion },
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
    expect(screen.getByRole('alert').textContent).toContain(
      'Semantic preview could not be loaded in time',
    )
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
})
