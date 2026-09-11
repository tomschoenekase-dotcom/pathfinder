import { describe, expect, it } from 'vitest'

import { retrieveGuestKnowledge, type GuestKnowledgeRow } from '../guest-knowledge-retrieval'
import { runGuestRetrievalBaseline } from './guest-retrieval-baseline'

type FixtureRow = GuestKnowledgeRow & {
  tenantId: string
  venueId: string
  visibility: 'PUBLIC' | 'INTERNAL'
  isEnabled: boolean
}

function fixture(
  id: string,
  title: string,
  content: string,
  visibility: FixtureRow['visibility'] = 'PUBLIC',
): FixtureRow {
  return {
    id,
    title,
    content,
    visibility,
    tenantId: 'museum-tenant',
    venueId: 'museum',
    isEnabled: true,
    category: 'museum handbook',
    sourceType: 'FOUNDER_PROVIDED',
    sourceName: 'Long museum source',
    sourceUrl: null,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    lastReviewedAt: new Date('2026-08-15T00:00:00Z'),
  }
}

function contains(row: FixtureRow, condition: Record<string, { contains: string }>): boolean {
  const [field, query] = Object.entries(condition)[0]!
  return String(row[field as keyof FixtureRow])
    .toLocaleLowerCase()
    .includes(query.contains.toLocaleLowerCase())
}

function matches(row: FixtureRow, where: Record<string, unknown>): boolean {
  if (
    row.tenantId !== where.tenantId ||
    row.venueId !== where.venueId ||
    row.isEnabled !== where.isEnabled
  )
    return false
  if (where.visibility && row.visibility !== where.visibility) return false
  const matchesOr = (items: Record<string, unknown>[]) =>
    items.some((item) => {
      if ('contentModuleId' in item) return row.contentModuleId == null
      return contains(row, item as Record<string, { contains: string }>)
    })
  if (
    Array.isArray(where.AND) &&
    !where.AND.every((group) => matchesOr((group as { OR: Record<string, unknown>[] }).OR))
  )
    return false
  if (Array.isArray(where.OR) && !matchesOr(where.OR as Record<string, unknown>[])) return false
  return true
}

describe('guest retrieval production-path evaluation', () => {
  it('runs the production retrieval function against long-tail, temporal, privacy, and multilingual holdouts', async () => {
    const corpus: FixtureRow[] = [
      fixture(
        'capacity-137-current',
        'Current North Gallery capacity',
        `Museum introduction. ${'Collections history and interpretation. '.repeat(180)} The North Gallery maximum occupancy is 137 visitors.`,
      ),
      fixture(
        'photos-current',
        'Current approved photography policy',
        'Visitors may take photos, but flash is prohibited.',
      ),
      fixture(
        'photos-stale',
        'Archived stale photography policy',
        'Visitors may use flash anywhere.',
      ),
      fixture(
        'photos-internal',
        'Internal photography exception',
        'Donor event photographers may use flash.',
        'INTERNAL',
      ),
      fixture('foreign-private', 'Maximum occupancy', 'Secret capacity is 999.'),
      ...Array.from({ length: 90 }, (_, index) =>
        fixture(
          `distractor-${index}`,
          'Recent gallery visitor program',
          `People can fit activities into program number ${index}.`,
        ),
      ),
    ]
    corpus.find((item) => item.id === 'foreign-private')!.tenantId = 'other-tenant'
    const seen: Record<string, unknown>[] = []
    const reader = {
      venueKnowledgeEntry: {
        findMany: async (args: Record<string, unknown>) => {
          seen.push(args)
          const where = args.where as Record<string, unknown>
          return corpus.filter((item) => matches(item, where)).slice(0, Number(args.take))
        },
      },
    }
    const cases = [
      ['How many guests can the North Gallery hold?', 'capacity-137-current'],
      ['¿Cuántas personas caben en la galería norte?', 'capacity-137-current'],
      ['Can I take pictures in the museum?', 'photos-current'],
    ] as const
    for (const [query, expected] of cases) {
      const result = await retrieveGuestKnowledge({
        reader,
        query,
        tenantId: 'museum-tenant',
        venueId: 'museum',
        includeSecondLayer: false,
        queryEmbedding: null,
      })
      expect(result.trace.path).toBe('lexical-fallback')
      expect(result.trace.retrievedSourceIds).toContain(expected)
      expect(result.trace.retrievedSources.find((source) => source.id === expected)?.version).toBe(
        '2026-08-01T00:00:00.000Z',
      )
      if (expected === 'photos-current') {
        expect(result.trace.retrievedSourceIds).toContain('photos-stale')
      }
      expect(result.trace.retrievedSourceIds).not.toContain('photos-internal')
      expect(result.trace.retrievedSourceIds).not.toContain('foreign-private')
      expect(result.entries.find((entry) => entry.id === expected)?.content).toMatch(
        expected.startsWith('capacity') ? /137/ : /flash is prohibited/,
      )
    }
    expect(seen.every((args) => Number(args.take) <= 60)).toBe(true)
  })

  it('measures the production helper and detects an actually slowed reader as a test-target regression', async () => {
    const row = fixture(
      'capacity-137-current',
      'Current North Gallery capacity',
      `${'Museum collection background. '.repeat(180)} Maximum occupancy is 137 visitors.`,
    )
    const reader = {
      venueKnowledgeEntry: {
        findMany: async () => {
          await new Promise((resolve) => setTimeout(resolve, 35))
          return [row]
        },
      },
    }
    const baseline = await runGuestRetrievalBaseline({
      reader,
      tenantId: 'museum-tenant',
      venueId: 'museum',
      intendedTestTargetMs: 20,
      cases: [
        {
          name: 'capacity-long-source-no-embedding',
          query: 'How many guests can the North Gallery hold?',
          expectedSourceId: row.id,
        },
      ],
    })

    expect(baseline.target).toEqual({
      kind: 'ENGINEERING_TEST_TARGET_NOT_SLO',
      intendedTestTargetMs: 20,
    })
    expect(baseline.measurements[0]!.retrievalMs).toBeGreaterThanOrEqual(30)
    expect(baseline.comparison).toEqual({
      allExpectedSourcesFound: true,
      allWithinIntendedTestTarget: false,
    })
    expect(baseline.provider).toEqual({
      called: false,
      latencyMs: null,
      estimatedCostUsd: null,
      invoiceCostUsd: null,
    })
  })

  it('retains conflicting published facts without invented lifecycle state and bounds a long current source', async () => {
    const current = fixture(
      'hours-current',
      'Approved museum schedule',
      `${'Información de la galería and visitor background. '.repeat(160)} Current holiday opening hours are 10:00 to 16:00. ${'Additional museum context. '.repeat(160)}`,
    )
    const archived = fixture(
      'hours-archived',
      'Archived obsolete museum gallery opening hours schedule',
      'The museum gallery opening hours are 08:00 to 20:00.',
    )
    archived.lastReviewedAt = new Date('2026-09-01T00:00:00Z')
    const corpus = [archived, current]
    const result = await retrieveGuestKnowledge({
      reader: {
        venueKnowledgeEntry: {
          findMany: async ({ where, take }: Record<string, unknown>) =>
            corpus
              .filter((row) => matches(row, where as Record<string, unknown>))
              .slice(0, Number(take)),
        },
      },
      query: 'What are the current museum gallery opening hours schedule?',
      tenantId: 'museum-tenant',
      venueId: 'museum',
      includeSecondLayer: false,
      queryEmbedding: null,
    })

    expect(result.trace.retrievedSourceIds).toContain(archived.id)
    expect(result.trace.truncatedSourceIds).toEqual([current.id])
    expect(result.entries.find((entry) => entry.id === current.id)?.content).toContain(
      '10:00 to 16:00',
    )
    expect(
      result.entries.find((entry) => entry.id === current.id)?.content.length,
    ).toBeLessThanOrEqual(4_000)
    expect(JSON.stringify(result.entries)).toContain('08:00 to 20:00')
  })

  it('keeps current policies whose subject contains lifecycle words and bounds scoped semantic results', async () => {
    const policy = fixture(
      'policy-current',
      'Expired tickets and archived exhibits access',
      'Expired tickets can be exchanged at the welcome desk. Archived exhibits remain accessible by appointment.',
    )
    const semantic = {
      ...fixture(
        'semantic-long',
        'Unicode visitor policy',
        `${'Préface générale. '.repeat(400)} Réservation spéciale: bring the expired ticket to the welcome desk.`,
      ),
      distance: 0.1,
    }
    let receivedScope: unknown
    const result = await retrieveGuestKnowledge({
      reader: {
        venueKnowledgeEntry: {
          findMany: async (args: { where: { id?: unknown } }) =>
            args.where.id ? [semantic] : [policy],
        },
      },
      query: 'What is the expired tickets archived exhibits access policy?',
      tenantId: 'museum-tenant',
      venueId: 'museum',
      includeSecondLayer: false,
      queryEmbedding: [0.2],
      semanticSearch: async (scope) => {
        receivedScope = scope
        return [semantic]
      },
    })

    expect(receivedScope).toEqual({
      tenantId: 'museum-tenant',
      venueId: 'museum',
      includeSecondLayer: false,
    })
    expect(result.trace.retrievedSourceIds).toContain(policy.id)
    expect(result.entries.find((entry) => entry.id === policy.id)?.content).toContain(
      'Expired tickets can be exchanged',
    )
    expect(result.trace.truncatedSourceIds).toContain(semantic.id)
    expect(
      result.entries.find((entry) => entry.id === semantic.id)?.content.length,
    ).toBeLessThanOrEqual(4_000)
  })
})
