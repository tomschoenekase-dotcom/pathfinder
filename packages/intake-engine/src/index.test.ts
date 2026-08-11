import { describe, expect, it, vi } from 'vitest'

import { IntakeSourceKind, type IntakeSource } from '@pathfinder/contracts/intake-engine'

import {
  createIntakeAdapterRegistry,
  INTAKE_EXECUTABLE_STAGES,
  INTAKE_NON_AUTOMATED_STAGES,
  orchestrateIntake,
  type ConfiguredAdapterResult,
  type IntakeSourceAdapter,
} from './index'

const NOW = new Date('2026-08-11T20:00:00.000Z')
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function source(overrides: Partial<IntakeSource> = {}): IntakeSource {
  return {
    id: 'source_web',
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    kind: 'WEBSITE',
    displayName: 'Venue website',
    uri: 'https://example.org/',
    capturedAt: NOW.toISOString(),
    ...overrides,
  }
}

function extracted(
  sourceId: string,
  overrides: Partial<ConfiguredAdapterResult<{ sourceId: string }>> = {},
): ConfiguredAdapterResult<{ sourceId: string }> {
  return {
    status: 'EXTRACTED',
    sourceId,
    evidence: [],
    discrepancies: [],
    claims: [],
    costUnits: 1,
    candidate: { sourceId },
    ...overrides,
  }
}

function websiteAdapter(
  implementation: IntakeSourceAdapter<{ sourceId: string }, 'WEBSITE'>['extract'] = async (item) =>
    extracted(item.id),
): IntakeSourceAdapter<{ sourceId: string }, 'WEBSITE'> {
  return { kind: 'WEBSITE', extract: vi.fn(implementation) }
}

function budget(overrides: Partial<Parameters<typeof orchestrateIntake>[0]['budget']> = {}) {
  return {
    maxSources: 20,
    maxEvidence: 100,
    maxDiscrepancies: 100,
    maxCostUnits: 100,
    maxDurationMs: 30_000,
    ...overrides,
  }
}

describe('intake adapter registry', () => {
  it('has parity with every shared source kind and never fakes unconfigured extraction', async () => {
    const adapter = websiteAdapter()
    const registry = createIntakeAdapterRegistry({ website: adapter })

    expect(registry.sourceKinds).toEqual(IntakeSourceKind.options)
    for (const kind of IntakeSourceKind.options) {
      const item = source({
        id: `source_${kind.toLowerCase()}`,
        kind,
      })
      const result = await registry.run(item, {
        signal: undefined,
        remainingCostUnits: 10,
        remainingTimeMs: 1_000,
      })
      if (kind === 'WEBSITE') {
        expect(result.status).toBe('EXTRACTED')
      } else {
        expect(result).toEqual({
          status: 'NOT_CONFIGURED',
          sourceId: item.id,
          sourceKind: kind,
          reason: 'ADAPTER_NOT_CONFIGURED',
          evidence: [],
          discrepancies: [],
          claims: [],
          costUnits: 0,
        })
      }
    }
    expect(adapter.extract).toHaveBeenCalledOnce()
  })
})

describe('intake orchestration', () => {
  it('deduplicates equivalent sources deterministically before extraction', async () => {
    const adapter = websiteAdapter()
    const registry = createIntakeAdapterRegistry({ website: adapter })
    const result = await orchestrateIntake(
      {
        sources: [
          source({ id: 'source_z', uri: 'https://example.org/?b=2&a=1#team' }),
          source({ id: 'source_a', uri: 'https://example.org/?a=1&b=2' }),
        ],
        budget: budget(),
      },
      { registry, now: () => NOW },
    )

    expect(adapter.extract).toHaveBeenCalledOnce()
    expect(adapter.extract).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'source_a' }),
      expect.anything(),
    )
    expect(result.duplicateSourceIds).toEqual({ source_z: 'source_a' })
    expect(result.proposal.sourceIds).toEqual(['source_a'])
  })

  it('cancels before adapter work and emits a truthful stopped lifecycle', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = websiteAdapter()

    const result = await orchestrateIntake(
      { sources: [source()], budget: budget(), signal: controller.signal },
      { registry: createIntakeAdapterRegistry({ website: adapter }), now: () => NOW },
    )

    expect(adapter.extract).not.toHaveBeenCalled()
    expect(result.proposal.status).toBe('CANCELLED')
    expect(result.stopReason).toBe('CANCELLED')
    expect(result.events.at(-1)).toEqual(
      expect.objectContaining({ state: 'STOPPED', reason: 'CANCELLED' }),
    )
  })

  it('honors cancellation raised during adapter execution', async () => {
    const controller = new AbortController()
    const adapter = websiteAdapter(async (item) => {
      controller.abort()
      return extracted(item.id)
    })

    const result = await orchestrateIntake(
      { sources: [source()], budget: budget(), signal: controller.signal },
      { registry: createIntakeAdapterRegistry({ website: adapter }), now: () => NOW },
    )

    expect(result.proposal.status).toBe('CANCELLED')
    expect(result.adapterResults).toEqual([])
  })

  it('stops when an adapter exceeds the cost budget and never hands off a draft', async () => {
    const adapter = websiteAdapter(async (item) => extracted(item.id, { costUnits: 6 }))
    const createDraftForReview = vi.fn()

    const result = await orchestrateIntake(
      { sources: [source()], budget: budget({ maxCostUnits: 5 }) },
      {
        registry: createIntakeAdapterRegistry({ website: adapter }),
        buildDraftCandidate: vi.fn(async () => ({ payload: true })),
        draftHandoff: { createDraftForReview },
        now: () => NOW,
      },
    )

    expect(result.proposal.status).toBe('FAILED')
    expect(result.stopReason).toBe('BUDGET_EXCEEDED')
    expect(result.budget.costUnitsUsed).toBe(6)
    expect(createDraftForReview).not.toHaveBeenCalled()
  })

  it('preserves adapter discrepancies and adds deterministic date-sensitive contradictions', async () => {
    const evidence = [
      {
        id: 'evidence_a',
        sourceId: 'source_web',
        locator: 'https://example.org/hours#summer',
        capturedAt: NOW.toISOString(),
        normalizedHash: HASH_A,
        confidence: 0.9,
      },
      {
        id: 'evidence_b',
        sourceId: 'source_web',
        locator: 'https://example.org/hours#autumn',
        capturedAt: NOW.toISOString(),
        normalizedHash: HASH_B,
        confidence: 0.8,
      },
    ]
    const preserved = {
      id: 'discrepancy_preserved',
      fieldPath: 'venue.phone',
      evidenceIds: ['evidence_a', 'evidence_b'],
      reason: 'LOW_CONFIDENCE' as const,
    }
    const adapter = websiteAdapter(async (item) =>
      extracted(item.id, {
        evidence,
        discrepancies: [preserved],
        claims: [
          {
            fieldPath: 'venue.hours.monday',
            value: '9–5 through August',
            evidenceId: 'evidence_a',
            dateSensitive: true,
            effectiveDate: '2026-08-31',
          },
          {
            fieldPath: 'venue.hours.monday',
            value: '10–4 from September',
            evidenceId: 'evidence_b',
            dateSensitive: true,
            effectiveDate: '2026-09-01',
          },
        ],
      }),
    )

    const result = await orchestrateIntake(
      { sources: [source()], budget: budget() },
      { registry: createIntakeAdapterRegistry({ website: adapter }), now: () => NOW },
    )

    expect(result.discrepancies).toContainEqual(preserved)
    expect(result.discrepancies).toContainEqual(
      expect.objectContaining({ fieldPath: 'venue.hours.monday', reason: 'DATE_SENSITIVE' }),
    )
    expect(result.proposal.discrepancyIds).toEqual(result.discrepancies.map((item) => item.id))
  })

  it('hands off only a deterministic draft-for-review and never automates approval or apply', async () => {
    const adapter = websiteAdapter()
    const createDraftForReview = vi.fn(async () => ({
      packageDraftId: 'draft_1',
      validationResultId: 'validation_1',
    }))

    const result = await orchestrateIntake(
      { sources: [source()], budget: budget() },
      {
        registry: createIntakeAdapterRegistry({ website: adapter }),
        buildDraftCandidate: vi.fn(async ({ adapterCandidates }) => ({ adapterCandidates })),
        draftHandoff: { createDraftForReview },
        now: () => NOW,
      },
    )

    expect(createDraftForReview).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reviewMode: 'DRAFT_ONLY',
        draftKey: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      }),
    )
    expect(result.proposal).toEqual(
      expect.objectContaining({
        status: 'AWAITING_REVIEW',
        packageDraftId: 'draft_1',
        validationResultId: 'validation_1',
        autoPublish: false,
      }),
    )
    expect(result.execution).toEqual({
      autoPublish: false,
      autoApply: false,
      lifecycleCommands: [],
    })
    expect(result.events.every((event) => !['APPROVE', 'APPLY'].includes(event.stage))).toBe(true)
    expect(INTAKE_EXECUTABLE_STAGES).not.toContain('APPROVE')
    expect(INTAKE_NON_AUTOMATED_STAGES).toEqual(
      expect.arrayContaining(['RESEARCH', 'CLASSIFY', 'PREVIEW', 'APPROVE', 'APPLY']),
    )
  })

  it('returns an explicit failed proposal when a source adapter is not configured', async () => {
    const registry = createIntakeAdapterRegistry()
    const document = source({
      id: 'source_document',
      kind: 'DOCUMENT',
      displayName: 'Visitor guide',
      uri: 'https://example.org/guide.docx',
    })

    const result = await orchestrateIntake(
      { sources: [document], budget: budget() },
      { registry, now: () => NOW },
    )

    expect(result.stopReason).toBe('ADAPTER_NOT_CONFIGURED')
    expect(result.proposal.status).toBe('FAILED')
    expect(result.adapterResults).toEqual([
      expect.objectContaining({
        status: 'NOT_CONFIGURED',
        sourceKind: 'DOCUMENT',
        reason: 'ADAPTER_NOT_CONFIGURED',
      }),
    ])
    expect(result.evidence).toEqual([])
  })
})
