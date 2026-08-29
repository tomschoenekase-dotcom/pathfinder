/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const mutate = vi.fn()
const clarificationMutate = vi.fn()
const interviewClarificationMutate = vi.fn()
const mappingQuery = vi.fn()
const mappingMutate = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      getIntakeBuilderLifecycle: { query },
      executeWebsiteIntakeResearch: { mutate },
      createWebsiteResearchClarificationQuestions: { mutate: clarificationMutate },
      createInterviewClarificationQuestions: { mutate: interviewClarificationMutate },
      previewWebsiteVenuePackageMapping: { query: mappingQuery },
      createAndLinkWebsiteMappingDraft: { mutate: mappingMutate },
    },
  }),
}))

import { IntakeBuilderLifecyclePanel } from './IntakeBuilderLifecyclePanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('IntakeBuilderLifecyclePanel', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('renders the full evidence-derived lifecycle and its blocker', async () => {
    query.mockResolvedValue({
      schemaVersion: 1,
      runId: 'run-a',
      sourceKind: 'WEBSITE',
      runStatus: 'AWAITING_REVIEW',
      websiteResearch: null,
      currentStage: 'RESEARCH',
      currentState: 'BLOCKED',
      nextAction: 'RUN_WEBSITE_RESEARCH',
      requiresHumanApproval: false,
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
      stages: [
        { stage: 'INGEST', state: 'COMPLETE', evidenceRefs: [], blockers: [] },
        {
          stage: 'RESEARCH',
          state: 'BLOCKED',
          evidenceRefs: [],
          blockers: [
            {
              code: 'WEBSITE_RESEARCH_REQUIRED',
              path: 'websiteResearch',
              message: 'Run bounded website research before analysis can complete.',
            },
          ],
        },
      ],
    })
    render(<IntakeBuilderLifecyclePanel tenantId="tenant-a" venueId="venue-a" runId="run-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Builder status' }))

    expect(await screen.findByRole('heading', { name: 'Research · blocked' })).toBeTruthy()
    expect(screen.getByText(/Run bounded website research before analysis/)).toBeTruthy()
    expect(query).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })
    expect(screen.getByRole('button', { name: 'Run bounded research' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })

  it('reuses one operation identity after an uncertain research failure', async () => {
    const operationId = '968c2e1a-8ece-47ad-98dc-e4bde64872ca'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    query.mockResolvedValue({
      schemaVersion: 1,
      runId: 'run-a',
      sourceKind: 'WEBSITE',
      runStatus: 'AWAITING_REVIEW',
      websiteResearch: null,
      currentStage: 'RESEARCH',
      currentState: 'BLOCKED',
      nextAction: 'RUN_WEBSITE_RESEARCH',
      requiresHumanApproval: false,
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
      stages: [
        { stage: 'INGEST', state: 'COMPLETE', evidenceRefs: [], blockers: [] },
        {
          stage: 'RESEARCH',
          state: 'BLOCKED',
          evidenceRefs: [],
          blockers: [
            {
              code: 'WEBSITE_RESEARCH_REQUIRED',
              path: 'websiteResearch',
              message: 'Run bounded website research before analysis can complete.',
            },
          ],
        },
      ],
    })
    mutate.mockRejectedValueOnce(new Error('Connection closed before acknowledgement.'))
    mutate.mockResolvedValueOnce({ receiptId: operationId })

    render(<IntakeBuilderLifecyclePanel tenantId="tenant-a" venueId="venue-a" runId="run-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Builder status' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run bounded research' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Connection closed')
    fireEvent.click(screen.getByRole('button', { name: 'Run bounded research' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls.map(([request]) => request.operationId)).toEqual([
      operationId,
      operationId,
    ])
  })

  it('queues missing website discrepancies for founder clarification with no authority controls', async () => {
    const lifecycle = {
      schemaVersion: 1,
      runId: 'run-a',
      sourceKind: 'WEBSITE',
      runStatus: 'AWAITING_REVIEW',
      websiteResearch: null,
      websiteClarificationReview: {
        receiptId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
        researchHash: 'a'.repeat(64),
        answersGrantAuthority: false,
        eligibleIdentities: [{ id: 'identity-a', name: 'Content reviewer' }],
        clarifications: [
          {
            discrepancyId: 'discrepancy-a',
            fieldPath: 'venue.name',
            reason: 'CONTRADICTION',
            evidence: [
              {
                label: 'venue.name (90% confidence)',
                reference: 'https://example.org/',
                summary: 'Example Hall · title',
              },
            ],
            proposedAnswer: {
              value: 'Example Hall',
              evidenceId: 'evidence-a',
              confidence: 0.9,
              status: 'PROPOSED_ONLY',
            },
            question: null,
          },
        ],
      },
      currentStage: 'RECONCILE',
      currentState: 'BLOCKED',
      nextAction: 'RESOLVE_CLARIFICATION',
      requiresHumanApproval: false,
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
      stages: [
        { stage: 'INGEST', state: 'COMPLETE', evidenceRefs: [], blockers: [] },
        { stage: 'RECONCILE', state: 'BLOCKED', evidenceRefs: [], blockers: [] },
      ],
    }
    query.mockResolvedValue(lifecycle)
    clarificationMutate.mockResolvedValue({ questions: [{ questionId: 'question-a' }] })

    render(<IntakeBuilderLifecyclePanel tenantId="tenant-a" venueId="venue-a" runId="run-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Builder status' }))
    expect(await screen.findByText('Founder clarification queue')).toBeTruthy()
    expect(screen.getByText(/cannot create a package, approve, apply, publish/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Queue founder clarification' }))

    await waitFor(() =>
      expect(clarificationMutate).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        receiptId: lifecycle.websiteClarificationReview.receiptId,
        expectedResearchHash: lifecycle.websiteClarificationReview.researchHash,
        discrepancyIds: ['discrepancy-a'],
        agentIdentityId: 'identity-a',
      }),
    )
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })

  it('previews exact citation selections and requires explicit review before creating a DRAFT', async () => {
    const lifecycle = {
      schemaVersion: 1,
      runId: 'run-a',
      sourceKind: 'WEBSITE',
      runStatus: 'AWAITING_REVIEW',
      websiteResearch: null,
      websiteClarificationReview: {
        receiptId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
        researchHash: 'a'.repeat(64),
        answersGrantAuthority: false,
        eligibleIdentities: [],
        clarifications: [],
        mappingOptions: [
          {
            evidenceId: 'phone-a',
            fieldPath: 'venue.phone',
            value: '312-555-0100',
            sourceUrl: 'https://example.org/contact',
            locator: 'json-ld',
            confidence: 0.9,
          },
        ],
      },
      currentStage: 'RECONCILE',
      currentState: 'BLOCKED',
      nextAction: 'RESOLVE_CLARIFICATION',
      requiresHumanApproval: false,
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
      stages: [
        { stage: 'INGEST', state: 'COMPLETE', evidenceRefs: [], blockers: [] },
        { stage: 'CONSTRUCT', state: 'PENDING', evidenceRefs: [], blockers: [] },
        { stage: 'RECONCILE', state: 'BLOCKED', evidenceRefs: [], blockers: [] },
      ],
    }
    const preview = {
      runId: 'run-a',
      receiptId: lifecycle.websiteClarificationReview.receiptId,
      researchHash: lifecycle.websiteClarificationReview.researchHash,
      mappingReviewHash: 'b'.repeat(64),
      candidateHash: 'c'.repeat(64),
      selections: [{ fieldPath: 'venue.phone', evidenceId: 'phone-a' }],
      payload: {},
      clarificationEvidence: [],
      ready: true,
      autoApprove: false,
      autoApply: false,
      published: false,
      answersGrantAuthority: false,
    }
    query.mockResolvedValue(lifecycle)
    mappingQuery.mockResolvedValue(preview)
    mappingMutate.mockResolvedValue({ packageId: 'package-a' })

    render(<IntakeBuilderLifecyclePanel tenantId="tenant-a" venueId="venue-a" runId="run-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Builder status' }))
    fireEvent.change(await screen.findByLabelText('venue.phone'), { target: { value: 'phone-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview reviewed mapping' }))
    expect(await screen.findByText('Exact DRAFT preview is ready')).toBeTruthy()
    const create = screen.getByRole('button', { name: 'Create linked Venue Package DRAFT' })
    expect((create as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I reviewed these exact citations and want to create a linked DRAFT.',
      }),
    )
    fireEvent.click(create)

    await waitFor(() =>
      expect(mappingMutate).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        receiptId: lifecycle.websiteClarificationReview.receiptId,
        expectedResearchHash: lifecycle.websiteClarificationReview.researchHash,
        expectedMappingReviewHash: preview.mappingReviewHash,
        expectedCandidateHash: preview.candidateHash,
        selections: preview.selections,
      }),
    )
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })

  it('queues staff-interview discrepancies as guidance and preserves source-amendment boundaries', async () => {
    const lifecycle = {
      schemaVersion: 1,
      runId: 'run-a',
      sourceKind: 'INTERVIEW',
      runStatus: 'AWAITING_REVIEW',
      websiteResearch: null,
      websiteClarificationReview: null,
      interviewClarificationReview: {
        reviewHash: 'a'.repeat(64),
        answersGrantAuthority: false,
        sourceAmendmentRequired: true,
        eligibleIdentities: [{ id: 'identity-a', name: 'Content reviewer' }],
        clarifications: [
          {
            clarificationId: 'interview-clarification-a',
            questionId: 'operations.hours',
            fieldPath: 'venue.operations.hours',
            reasons: ['LOW_CONFIDENCE'],
            evidence: [
              {
                label: 'What are the public hours?',
                reference: 'intake-evidence:evidence-a',
                summary: 'Open nine to five. · 55% confidence',
              },
            ],
            proposedAnswer: {
              value: 'Open nine to five.',
              confidence: 0.55,
              evidenceId: 'evidence-a',
              status: 'PROPOSED_ONLY',
            },
            question: null,
          },
        ],
      },
      currentStage: 'RECONCILE',
      currentState: 'BLOCKED',
      nextAction: 'RESOLVE_CLARIFICATION',
      requiresHumanApproval: false,
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
      stages: [
        { stage: 'INGEST', state: 'COMPLETE', evidenceRefs: [], blockers: [] },
        { stage: 'RECONCILE', state: 'BLOCKED', evidenceRefs: [], blockers: [] },
      ],
    }
    query.mockResolvedValue(lifecycle)
    interviewClarificationMutate.mockResolvedValue({ questions: [{ questionId: 'question-a' }] })

    render(<IntakeBuilderLifecyclePanel tenantId="tenant-a" venueId="venue-a" runId="run-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Builder status' }))
    expect(await screen.findByText(/Staff answers remain evidence/)).toBeTruthy()
    expect(screen.getByText('What are the public hours?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Queue founder clarification' }))

    await waitFor(() =>
      expect(interviewClarificationMutate).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        expectedReviewHash: lifecycle.interviewClarificationReview.reviewHash,
        clarificationIds: ['interview-clarification-a'],
        agentIdentityId: 'identity-a',
      }),
    )
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })

  it('shows verified file provenance while keeping extraction and authority fail closed', async () => {
    query.mockResolvedValue({
      schemaVersion: 1,
      runId: 'run-file',
      sourceKind: 'FILE_UPLOAD',
      runStatus: 'AWAITING_REVIEW',
      websiteResearch: null,
      fileUpload: {
        uploadId: 'upload-a',
        displayName: 'Visitor guide source',
        fileName: 'visitor-guide.pdf',
        mimeType: 'application/pdf',
        category: 'DOCUMENT',
        byteSize: 4096,
        sha256: 'c'.repeat(64),
        verifiedAt: new Date('2026-08-29T02:00:00.000Z'),
      },
      websiteClarificationReview: null,
      interviewClarificationReview: null,
      currentStage: 'EXTRACT',
      currentState: 'BLOCKED',
      nextAction: 'REVIEW_FILE_SOURCE',
      requiresHumanApproval: false,
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
      stages: [
        { stage: 'INGEST', state: 'COMPLETE', evidenceRefs: [], blockers: [] },
        {
          stage: 'EXTRACT',
          state: 'BLOCKED',
          evidenceRefs: ['intake-upload:upload-a'],
          blockers: [
            {
              code: 'FILE_EXTRACTION_REVIEW_REQUIRED',
              path: 'fileUpload',
              message:
                'The verified file is retained, but no reviewed extraction is available for a package candidate.',
            },
          ],
        },
      ],
    })

    render(<IntakeBuilderLifecyclePanel tenantId="tenant-a" venueId="venue-a" runId="run-file" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Builder status' }))

    expect(await screen.findByRole('heading', { name: 'Extract · blocked' })).toBeTruthy()
    expect(screen.getByText('Verified file source')).toBeTruthy()
    expect(screen.getByText('Visitor guide source')).toBeTruthy()
    expect(screen.getByText('visitor-guide.pdf')).toBeTruthy()
    expect(screen.getByText('application/pdf · 4 KB')).toBeTruthy()
    expect(screen.getByText('c'.repeat(64))).toBeTruthy()
    expect(screen.getByText(/No approval, apply, publication, or provider work/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })
})
