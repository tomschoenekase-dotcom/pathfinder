import { afterEach, describe, expect, it, vi } from 'vitest'

import * as agentQuestionActions from '@pathfinder/db'

import {
  buildWebsiteClarificationReview,
  createWebsiteResearchClarificationQuestions,
  websiteResearchClarificationOperationId,
  WebsiteClarificationError,
} from './intake-website-clarifications'

const scope = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  runId: 'run-a',
  receiptId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
}

const researchSnapshot = {
  schemaVersion: 1,
  sourceId: 'run-a',
  pages: [],
  citations: [
    {
      evidenceId: 'evidence-a',
      fieldPath: 'venue.name',
      value: 'Example Hall',
      sourceUrl: 'https://example.org/',
      locator: 'title',
      confidence: 0.9,
      dateSensitive: false,
      effectiveDate: null,
    },
    {
      evidenceId: 'evidence-b',
      fieldPath: 'venue.name',
      value: 'Example Ballroom',
      sourceUrl: 'https://example.org/about',
      locator: 'meta[property="og:title"]',
      confidence: 0.7,
      dateSensitive: false,
      effectiveDate: null,
    },
  ],
  evidence: [],
  discrepancies: [
    {
      id: 'discrepancy-a',
      fieldPath: 'venue.name',
      evidenceIds: ['evidence-a', 'evidence-b'],
      reason: 'CONTRADICTION',
    },
  ],
}

describe('website research clarifications', () => {
  afterEach(() => vi.restoreAllMocks())
  it('projects deterministic, evidence-backed questions without action authority', () => {
    const first = buildWebsiteClarificationReview({
      ...scope,
      researchSnapshot,
      candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
    })
    const second = buildWebsiteClarificationReview({
      ...scope,
      researchSnapshot: { ...researchSnapshot },
      candidateSnapshot: { draftInput: null, kind: 'TYPED_INTERMEDIATE' },
    })

    expect(second).toEqual(first)
    expect(first.researchHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.clarifications[0]).toMatchObject({
      discrepancyId: 'discrepancy-a',
      questionType: 'MULTIPLE_CHOICE',
      choices: ['Example Hall', 'Example Ballroom'],
      proposedAnswer: { value: 'Example Hall', status: 'PROPOSED_ONLY' },
    })
    expect(first.clarifications[0]?.context).toContain('grants no approval')
  })

  it('binds operation identity to the full tenant, venue, run, receipt, evidence, and discrepancy scope', () => {
    const base = websiteResearchClarificationOperationId({
      ...scope,
      researchHash: 'a'.repeat(64),
      discrepancyId: 'discrepancy-a',
    })
    expect(base).toMatch(/^[a-f0-9-]{36}$/u)
    expect(
      websiteResearchClarificationOperationId({
        ...scope,
        researchHash: 'b'.repeat(64),
        discrepancyId: 'discrepancy-a',
      }),
    ).not.toBe(base)
  })

  it('fails closed when discrepancy evidence is missing or the run scope is forged', () => {
    expect(() =>
      buildWebsiteClarificationReview({
        ...scope,
        runId: 'run-b',
        researchSnapshot,
        candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
      }),
    ).toThrow(WebsiteClarificationError)
    expect(() =>
      buildWebsiteClarificationReview({
        ...scope,
        researchSnapshot: {
          ...researchSnapshot,
          discrepancies: [
            { ...researchSnapshot.discrepancies[0], evidenceIds: ['evidence-a', 'missing'] },
          ],
        },
        candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
      }),
    ).toThrow(/missing website evidence/u)
  })

  it('persists exact selected questions while returning explicit no-authority boundaries', async () => {
    const review = buildWebsiteClarificationReview({
      ...scope,
      researchSnapshot,
      candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
    })
    const ask = vi.spyOn(agentQuestionActions, 'askAgentQuestionAction').mockResolvedValue({
      question: { id: 'question-a', status: 'PENDING' },
      replayed: false,
    } as never)
    const db = {
      intakeRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: scope.runId,
          websiteResearchReceipts: [
            {
              id: scope.receiptId,
              outcome: 'SUCCEEDED',
              researchSnapshot,
              candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
            },
          ],
        }),
      },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-a' }) },
    }

    const result = await createWebsiteResearchClarificationQuestions({
      db: db as never,
      ...scope,
      expectedResearchHash: review.researchHash,
      discrepancyIds: ['discrepancy-a'],
      agentIdentityId: 'identity-a',
    })

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: review.clarifications[0]?.operationId,
        category: 'builder-website-clarification',
        blocking: true,
        callbackMetadata: expect.objectContaining({
          workflow: 'intake-website-clarification',
          researchHash: review.researchHash,
        }),
      }),
      db,
    )
    expect(result).toMatchObject({
      questions: [{ discrepancyId: 'discrepancy-a', questionId: 'question-a' }],
      executionTriggered: false,
      approvalGranted: false,
      canonicalVenueChanged: false,
      packageDraftCreated: false,
      publicationTriggered: false,
      venueContactTriggered: false,
    })
  })

  it('rejects stale research before a question can be written', async () => {
    const ask = vi.spyOn(agentQuestionActions, 'askAgentQuestionAction')
    const db = {
      intakeRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: scope.runId,
          websiteResearchReceipts: [
            {
              id: scope.receiptId,
              outcome: 'SUCCEEDED',
              researchSnapshot,
              candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
            },
          ],
        }),
      },
    }
    await expect(
      createWebsiteResearchClarificationQuestions({
        db: db as never,
        ...scope,
        expectedResearchHash: 'f'.repeat(64),
        discrepancyIds: ['discrepancy-a'],
        agentIdentityId: 'identity-a',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(ask).not.toHaveBeenCalled()
  })
})
