/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const adminQuery = vi.fn()
const candidateQuery = vi.fn()
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    intake: { getProposalReview: { query } },
    admin: {
      getIntakeProposalReview: { query: adminQuery },
      getIntakeVenuePackageCandidate: { query: candidateQuery },
      createAndLinkIntakeCandidateDraft: { mutate: vi.fn() },
    },
  }),
}))
import { IntakeProposalReview } from './IntakeProposalReview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('privacy-safe interview review', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows public text and safe withheld status without internal review fields', async () => {
    query.mockResolvedValue({
      id: 'run-1',
      role: 'OPERATIONS',
      consentVerified: true,
      answers: [
        {
          questionId: 'operations.hours',
          prompt: 'What are the hours?',
          privacy: 'PUBLIC_CANDIDATE',
          publicText: 'Open daily.',
          skipped: false,
          redacted: false,
          hasEvidence: true,
        },
        {
          questionId: 'operations.internal-procedures',
          prompt: 'Internal procedure?',
          privacy: 'PRIVATE',
          publicText: null,
          skipped: false,
          redacted: false,
          hasEvidence: true,
        },
      ],
    })
    render(<IntakeProposalReview clientFacing venueId="venue-a" runId="run-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review what you shared' }))
    expect(await screen.findByText('Open daily.')).toBeTruthy()
    expect(screen.getByText(/Answer text kept private/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('private raw answer')
    expect(document.querySelector('audio')).toBeNull()
    expect(document.querySelector('video')).toBeNull()
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })

  it('projects client review without internal readiness, confidence, or discrepancy assessments', async () => {
    query.mockResolvedValue({
      id: 'run-client',
      role: 'OPERATIONS',
      consentVerified: true,
      answers: [
        {
          questionId: 'operations.hours',
          prompt: 'What are the hours?',
          privacy: 'PUBLIC_CANDIDATE',
          publicText: 'Open daily.',
          skipped: false,
          redacted: false,
          hasEvidence: true,
        },
      ],
    })
    render(<IntakeProposalReview clientFacing venueId="venue-a" runId="run-client" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review what you shared' }))
    expect(await screen.findByText('Open daily.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /handoff|ready for|12%|confidence|LOW_CONFIDENCE_INTERNAL_SENTINEL|INTERNAL_ASSESSMENT_SENTINEL|INTERNAL_EVENT_SENTINEL|evidence hash|reviewer flag/iu,
    )
  })

  it('loads the server-built candidate for an admin handoff without client mapping', async () => {
    adminQuery.mockResolvedValue(reviewResult(true))
    candidateQuery.mockResolvedValue(candidateResult('run-1', 'a'.repeat(64)))
    render(<IntakeProposalReview adminTenantId="tenant-a" venueId="venue-a" runId="run-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review interview evidence' }))
    expect(await screen.findByText(/Candidate from reviewed staff interview/)).toBeTruthy()
    expect(candidateQuery).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
    })
    expect(
      (screen.getByLabelText('VenuePackage payload JSON') as HTMLTextAreaElement).readOnly,
    ).toBe(true)
  })

  it('ignores a stale candidate response after the selected run changes', async () => {
    let resolveFirst!: (value: ReturnType<typeof candidateResult>) => void
    adminQuery.mockResolvedValue(reviewResult(true))
    candidateQuery
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce(candidateResult('run-2', 'b'.repeat(64)))
    const { rerender } = render(
      <IntakeProposalReview adminTenantId="tenant-a" venueId="venue-a" runId="run-1" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review interview evidence' }))
    await waitFor(() => expect(candidateQuery).toHaveBeenCalledTimes(1))

    rerender(<IntakeProposalReview adminTenantId="tenant-a" venueId="venue-a" runId="run-2" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review interview evidence' }))
    expect(await screen.findByText(/Candidate from reviewed staff interview/)).toBeTruthy()
    resolveFirst(candidateResult('run-1', 'a'.repeat(64)))
    await waitFor(() =>
      expect(screen.getByLabelText('VenuePackage payload JSON').textContent).not.toContain('run-1'),
    )
    expect(candidateQuery).toHaveBeenCalledTimes(2)
  })

  it('offers a fenced retry when candidate loading fails after evidence is shown', async () => {
    adminQuery.mockResolvedValue(reviewResult(true))
    candidateQuery
      .mockRejectedValueOnce(new Error('Semantic candidate unavailable'))
      .mockResolvedValueOnce(candidateResult('run-1', 'a'.repeat(64)))
    render(<IntakeProposalReview adminTenantId="tenant-a" venueId="venue-a" runId="run-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Review interview evidence' }))
    expect(await screen.findByText('Semantic candidate unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry candidate review' }))
    expect(await screen.findByText(/Candidate from reviewed staff interview/)).toBeTruthy()
    expect(candidateQuery).toHaveBeenCalledTimes(2)
  })
})

function reviewResult(handoffReady: boolean) {
  return {
    id: 'run-1',
    role: 'OPERATIONS',
    consentVerified: true,
    summary: { evidenceCount: 2, discrepancyCount: 0 },
    structuredSummary: { handoffReady },
    answers: [],
    timeline: [],
  }
}

function candidateResult(runId: string, candidateHash: string) {
  return {
    runId,
    sourceKind: 'INTERVIEW' as const,
    status: 'AWAITING_REVIEW',
    ready: true,
    candidateHash,
    payload: {
      schemaVersion: 3 as const,
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: {
        create: [
          {
            itemKey: '72d81eaf-b74b-5a28-bb46-f580fbbdb8a4',
            provenance: {
              sourceType: 'PATHFINDER_INTAKE',
              contentOrigin: 'HUMAN_AUTHORED' as const,
            },
            value: {
              title: `Candidate ${runId}`,
              category: 'STAFF_INTERVIEW',
              content: 'Open daily.',
              isEnabled: true,
            },
          },
        ],
        update: [],
        delete: [],
      },
    },
    issues: [],
    summary: { candidateCount: 1, issueCount: 0 },
    autoApprove: false as const,
    autoApply: false as const,
    published: false as const,
  }
}
