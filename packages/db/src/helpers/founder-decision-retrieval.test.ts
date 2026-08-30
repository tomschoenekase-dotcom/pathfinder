import { describe, expect, it, vi } from 'vitest'

import {
  FounderDecisionRetrievalError,
  getFounderDecisionCurrentTruth,
} from './founder-decision-retrieval'

const current = (id: string, key: string) => ({
  id,
  title: 'Production release boundary',
  summary: 'Major production changes remain founder-gated.',
  effectiveAt: new Date('2026-08-22T05:00:00.000Z'),
  lastConfirmedAt: new Date('2026-08-23T05:00:00.000Z'),
  contentHash: 'a'.repeat(64),
  entityLinks: [{ entityId: key }],
  revisions: [
    {
      revision: 1,
      body: 'Major releases require founder awareness or approval.',
      sourceDigest: 'b'.repeat(64),
      createdAt: new Date('2026-08-23T05:00:00.000Z'),
    },
  ],
  sources: [
    {
      sourceType: 'HUMAN_ENTRY',
      sourceId: 'torchiko-founder-direction-2026-08-22',
      sourceRef: 'vault://07 Decisions/Torchiko Founder Engineering Direction 2026-08-22.md',
      occurredAt: new Date('2026-08-22T05:00:00.000Z'),
      metadata: { decisionKey: key },
    },
  ],
  decision: {
    id: `decision_${id}`,
    decision: 'Major releases require founder awareness or approval.',
    rationale: 'Production customer impact is consequential.',
    scope: { majorProductionReleaseAuthorized: false },
    affectedSystems: ['production'],
    effectiveAt: new Date('2026-08-22T05:00:00.000Z'),
    supersedesId: null,
  },
})

describe('getFounderDecisionCurrentTruth', () => {
  it('returns exact current decisions in requested order and reports missing keys', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        current('second', 'billing-launch-policy'),
        current('first', 'production-release-boundary'),
      ])
    const result = await getFounderDecisionCurrentTruth(
      {
        keys: ['production-release-boundary', 'missing-decision', 'billing-launch-policy'],
      },
      { companyKnowledgeItem: { findMany } } as never,
    )
    expect(result.decisions.map((decision) => decision.key)).toEqual([
      'production-release-boundary',
      'billing-launch-policy',
    ])
    expect(result).toMatchObject({ complete: false, missingKeys: ['missing-decision'] })
    expect(result.decisions[0]).toMatchObject({
      effectiveAt: '2026-08-22T05:00:00.000Z',
      scope: { majorProductionReleaseAuthorized: false },
      provenance: [expect.objectContaining({ sourceType: 'HUMAN_ENTRY' })],
    })
  })

  it('fails closed when one stable key has multiple current records', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        current('one', 'production-release-boundary'),
        current('two', 'production-release-boundary'),
      ])
    await expect(
      getFounderDecisionCurrentTruth({ keys: ['production-release-boundary'] }, {
        companyKnowledgeItem: { findMany },
      } as never),
    ).rejects.toBeInstanceOf(FounderDecisionRetrievalError)
  })

  it('rejects duplicate and unstable lookup keys before querying', async () => {
    const findMany = vi.fn()
    const client = { companyKnowledgeItem: { findMany } } as never
    await expect(
      getFounderDecisionCurrentTruth({ keys: ['one-key', 'one-key'] }, client),
    ).rejects.toThrow(/unique/u)
    await expect(getFounderDecisionCurrentTruth({ keys: ['Not stable'] }, client)).rejects.toThrow()
    expect(findMany).not.toHaveBeenCalled()
  })
})
