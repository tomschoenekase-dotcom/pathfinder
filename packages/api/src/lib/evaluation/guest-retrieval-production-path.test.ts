import { describe, expect, it } from 'vitest'

import { retrieveGuestKnowledge, type GuestKnowledgeRow } from '../guest-knowledge-retrieval'

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
    items.some((item) => contains(row, item as Record<string, { contains: string }>))
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
      expect(result.trace.retrievedSourceIds).not.toContain('photos-stale')
      expect(result.trace.retrievedSourceIds).not.toContain('photos-internal')
      expect(result.trace.retrievedSourceIds).not.toContain('foreign-private')
      expect(result.entries.find((entry) => entry.id === expected)?.content).toMatch(
        expected.startsWith('capacity') ? /137/ : /flash is prohibited/,
      )
    }
    expect(seen.every((args) => Number(args.take) <= 60)).toBe(true)
  })
})
