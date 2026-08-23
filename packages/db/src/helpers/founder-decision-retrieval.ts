import {
  FounderDecisionCurrentTruthRequest,
  type FounderDecisionCurrentTruthRequest as FounderDecisionCurrentTruthRequestInput,
} from '@pathfinder/contracts/company-brain'

import { db } from '../client'

export type FounderDecisionRetrievalClient = Pick<typeof db, 'companyKnowledgeItem'>

export class FounderDecisionRetrievalError extends Error {
  constructor(
    readonly code: 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'FounderDecisionRetrievalError'
  }
}

/**
 * Resolves exact platform founder decisions by stable key. Authorization belongs at the caller;
 * this helper deliberately performs no tenant-scoped fallback or fuzzy matching.
 */
export async function getFounderDecisionCurrentTruth(
  rawInput: FounderDecisionCurrentTruthRequestInput,
  client: FounderDecisionRetrievalClient = db,
) {
  const input = FounderDecisionCurrentTruthRequest.parse(rawInput)
  const rows = await client.companyKnowledgeItem.findMany({
    where: {
      type: 'DECISION',
      authority: 'AUTHORITATIVE_CURRENT',
      promotionStatus: 'PROMOTED',
      archivedAt: null,
      decision: { status: 'ACTIVE' },
      entityLinks: {
        some: {
          entityType: 'FOUNDER_DECISION_KEY',
          entityId: { in: input.keys },
          relationship: 'GOVERNS',
        },
      },
    },
    orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      title: true,
      summary: true,
      effectiveAt: true,
      lastConfirmedAt: true,
      contentHash: true,
      entityLinks: {
        where: {
          entityType: 'FOUNDER_DECISION_KEY',
          entityId: { in: input.keys },
          relationship: 'GOVERNS',
        },
        select: { entityId: true },
      },
      revisions: {
        orderBy: { revision: 'desc' },
        take: 1,
        select: { revision: true, body: true, sourceDigest: true, createdAt: true },
      },
      sources: {
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          sourceType: true,
          sourceId: true,
          sourceRef: true,
          occurredAt: true,
          metadata: true,
        },
      },
      decision: {
        select: {
          id: true,
          decision: true,
          rationale: true,
          scope: true,
          affectedSystems: true,
          effectiveAt: true,
          supersedesId: true,
        },
      },
    },
  })

  const rowsByKey = new Map<string, typeof rows>()
  for (const row of rows) {
    if (row.entityLinks.length !== 1) {
      throw new FounderDecisionRetrievalError(
        'CONFLICT',
        `Current founder decision ${row.id} has invalid stable-key lineage.`,
      )
    }
    const key = row.entityLinks[0]!.entityId
    rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row])
  }

  const decisions = []
  const missingKeys: string[] = []
  for (const key of input.keys) {
    const matches = rowsByKey.get(key) ?? []
    if (matches.length === 0) {
      missingKeys.push(key)
      continue
    }
    if (matches.length > 1) {
      throw new FounderDecisionRetrievalError(
        'CONFLICT',
        `Founder decision ${key} has multiple current records and requires reconciliation.`,
      )
    }
    const row = matches[0]!
    const revision = row.revisions[0]
    if (!row.decision || !revision) {
      throw new FounderDecisionRetrievalError(
        'CONFLICT',
        `Founder decision ${key} is missing current decision detail.`,
      )
    }
    decisions.push({
      key,
      knowledgeItemId: row.id,
      decisionId: row.decision.id,
      title: row.title,
      summary: row.summary,
      decision: row.decision.decision,
      rationale: row.decision.rationale,
      scope: row.decision.scope,
      affectedSystems: row.decision.affectedSystems,
      effectiveAt: (row.decision.effectiveAt ?? row.effectiveAt)?.toISOString() ?? null,
      lastConfirmedAt: row.lastConfirmedAt?.toISOString() ?? null,
      supersedesDecisionId: row.decision.supersedesId,
      contentHash: row.contentHash,
      revision: {
        number: revision.revision,
        sourceDigest: revision.sourceDigest,
        createdAt: revision.createdAt.toISOString(),
      },
      provenance: row.sources.map((source) => ({
        ...source,
        occurredAt: source.occurredAt?.toISOString() ?? null,
      })),
    })
  }

  return {
    schemaVersion: 'founder-decision-current-truth.v1' as const,
    complete: missingKeys.length === 0,
    decisions,
    missingKeys,
    resolution: {
      exactStableKeys: true,
      fuzzyMatching: false,
      currentOnly: true,
      ambiguityFailsClosed: true,
    },
  }
}
