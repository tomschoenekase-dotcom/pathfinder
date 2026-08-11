import type { WebsiteIntakeBounds } from '@pathfinder/contracts/intake-engine'
import type { IntakeSourceAdapter } from '@pathfinder/intake-engine'

import {
  buildWebsiteIntakeProposal,
  WebsiteIntakePolicyError,
  type WebsiteIntakeDependencies,
  type WebsiteIntakeResult,
} from './website-intake'

export type WebsiteIntakeAdapterCandidate = WebsiteIntakeResult['packageBinding']

export function createWebsiteIntakeSourceAdapter(options: {
  bounds: WebsiteIntakeBounds
  userAgent: string
  dependencies: (sourceId: string) => WebsiteIntakeDependencies
}): IntakeSourceAdapter<WebsiteIntakeAdapterCandidate, 'WEBSITE'> {
  return {
    kind: 'WEBSITE',
    async extract(source, context) {
      if (!source.uri) throw new WebsiteIntakePolicyError('WEBSITE intake sources require a URI')
      const result = await buildWebsiteIntakeProposal(
        {
          tenantId: source.tenantId,
          venueId: source.venueId,
          sourceId: source.id,
          startUrl: source.uri,
          bounds: options.bounds,
          userAgent: options.userAgent,
          maxDurationMs: Math.min(context.remainingTimeMs, 300_000),
          ...(context.signal ? { signal: context.signal } : {}),
        },
        options.dependencies(source.id),
      )
      return {
        status: 'EXTRACTED',
        sourceId: source.id,
        evidence: result.intermediate.evidence,
        discrepancies: result.intermediate.discrepancies,
        claims: result.intermediate.citations.map((citation) => ({
          fieldPath: citation.fieldPath,
          value: citation.value,
          evidenceId: citation.evidenceId,
          dateSensitive: citation.dateSensitive,
          ...(citation.effectiveDate !== null ? { effectiveDate: citation.effectiveDate } : {}),
        })),
        costUnits: result.job.estimatedCostUnits,
        candidate: result.packageBinding,
      }
    },
  }
}
