/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const mutate = vi.fn()
const clarificationMutate = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      getIntakeBuilderLifecycle: { query },
      executeWebsiteIntakeResearch: { mutate },
      createWebsiteResearchClarificationQuestions: { mutate: clarificationMutate },
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
})
