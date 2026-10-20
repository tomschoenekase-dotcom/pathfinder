import { describe, expect, it, vi } from 'vitest'
import {
  revalidateGuestQuestionEvidence,
  revalidateGuestQuestionPlaces,
} from './guest-question-evidence'
import type { GuestDirectoryKnowledge, GuestDirectoryPlace } from './guest-venue-directory'

type Row = Record<string, unknown> & { id: string }
const scope = {
  tenantId: 'synthetic-tenant',
  venueId: 'synthetic-venue',
  includeSecondLayer: false,
}
const now = new Date('2026-10-20T12:00:00Z')
function topic(id: string): Row {
  return {
    id,
    ...scope,
    title: 'Orchid greenhouse policy',
    category: 'POLICIES',
    content: 'Old accompaniment requirement.',
    sourceType: 'MANUAL',
    sourceName: null,
    sourceUrl: null,
    updatedAt: new Date('2026-10-01'),
    lastReviewedAt: null,
    visibility: 'PUBLIC',
    isEnabled: true,
    contentModuleId: null,
    contentRevisionId: null,
    universalContentAdoption: null,
  }
}
function place(id: string): Row {
  return {
    id,
    ...scope,
    name: 'Orchid greenhouse',
    type: 'OTHER',
    itemType: null,
    shortDescription: 'Old greenhouse location.',
    longDescription: null,
    tags: [],
    areaName: null,
    hours: null,
    lat: 0,
    lng: 0,
    photoUrl: null,
    sourceType: 'MANUAL',
    sourceName: null,
    sourceUrl: null,
    visibility: 'PUBLIC',
    isActive: true,
  }
}
function matches(value: unknown, predicate: unknown): boolean {
  if (predicate === null) return value == null
  if (typeof predicate !== 'object' || predicate instanceof Date) return value === predicate
  return Object.entries(predicate as Record<string, unknown>).every(([key, expected]) => {
    if (key === 'AND')
      return (Array.isArray(expected) ? expected : [expected]).every((p) => matches(value, p))
    if (key === 'OR') return (expected as unknown[]).some((p) => matches(value, p))
    if (key === 'NOT' || key === 'not') return !matches(value, expected)
    if (key === 'is') return matches(value, expected)
    if (key === 'in') return (expected as unknown[]).includes(value)
    if (key === 'startsWith')
      return typeof value === 'string' && value.startsWith(expected as string)
    if (key === 'gt') return (value as Date) > (expected as Date)
    if (key === 'lte') return (value as Date) <= (expected as Date)
    return matches((value as Record<string, unknown> | null)?.[key], expected)
  })
}
function readerFor(rows: Row[], adopted: string[] = []) {
  const read = vi.fn(async (args: Record<string, unknown>) =>
    rows.filter((row) => matches(row, args.where)),
  )
  return {
    venueKnowledgeEntry: { findMany: read },
    place: { findMany: read },
    legacyKnowledgeAdoptionActivation: {
      findMany: vi.fn(async () =>
        adopted.map((id) => ({ adoption: { legacyKnowledgeEntryId: id } })),
      ),
    },
  }
}

describe('evidence dynamic body boundaries', () => {
  it('uses the newly edited whole knowledge body, including a deciding late sentence', async () => {
    const old = topic('policy')
    const live = {
      ...old,
      content:
        'First sentence. Second sentence. Visitors under eight require two adults after 6pm.',
      updatedAt: now,
    }
    const reader = readerFor([live])
    const result = await revalidateGuestQuestionEvidence({
      ...scope,
      reader,
      asOf: now,
      currentDate: '2026-10-20',
      knowledge: [old as unknown as GuestDirectoryKnowledge],
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.content).toBe(live.content)
    expect(result[0]?.updatedAt).toEqual(now)
    expect(reader.venueKnowledgeEntry.findMany.mock.calls[0]?.[0].where).toMatchObject({
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      visibility: 'PUBLIC',
      id: { in: ['policy'] },
    })
  })

  it.each([
    ['foreign tenant', { tenantId: 'other' }],
    ['foreign venue', { venueId: 'other' }],
    ['private', { visibility: 'PRIVATE' }],
    ['disabled', { isEnabled: false }],
    ['connected', { sourceType: 'SOURCE_CONNECTION' }],
    ['adopted', {}],
    ['deleted', null],
  ] as const)(
    'drops a knowledge body that became %s after index selection',
    async (kind, changes) => {
      const old = topic('policy')
      const reader = readerFor(
        changes === null ? [] : [{ ...old, ...changes }],
        kind === 'adopted' ? ['policy'] : [],
      )
      expect(
        await revalidateGuestQuestionEvidence({
          ...scope,
          reader,
          asOf: now,
          currentDate: '2026-10-20',
          knowledge: [old as unknown as GuestDirectoryKnowledge],
        }),
      ).toEqual([])
    },
  )

  it('drops a module when a later publication withdraws authority without changing the cached row body', async () => {
    const old = topic('module')
    const live = {
      ...old,
      contentModuleId: 'module',
      contentRevisionId: 'revision',
      contentPublicationId: 'original',
      contentRevision: {
        audience: 'PUBLIC',
        kind: 'ARTICLE',
        effectiveFrom: null,
        effectiveUntil: null,
        operationalFact: null,
        createdBy: 'operator',
      },
      contentPublication: {
        action: 'PUBLISH',
        eventOrder: 1n,
        module: { publications: [{ id: 'withdrawal', eventOrder: 2n }] },
      },
    }
    expect(
      await revalidateGuestQuestionEvidence({
        ...scope,
        reader: readerFor([live]),
        asOf: now,
        currentDate: '2026-10-20',
        knowledge: [old as unknown as GuestDirectoryKnowledge],
      }),
    ).toEqual([])
  })

  it('uses current whole place descriptions and drops hidden, inactive, foreign and deleted places', async () => {
    const old = ['current', 'hidden', 'inactive', 'tenant', 'venue', 'deleted'].map(place)
    const currentDescription =
      'First sentence. Second sentence. The entrance is now at the east gate.'
    const live = [
      {
        ...old[0]!,
        longDescription: currentDescription,
      },
      { ...old[1]!, visibility: 'PRIVATE' },
      { ...old[2]!, isActive: false },
      { ...old[3]!, tenantId: 'other' },
      { ...old[4]!, venueId: 'other' },
    ]
    const reader = readerFor(live)
    const result = await revalidateGuestQuestionPlaces({
      ...scope,
      reader,
      places: old as unknown as GuestDirectoryPlace[],
    })
    expect(result.map((row) => row.id)).toEqual(['current'])
    expect(result[0]?.longDescription).toBe(currentDescription)
    expect(reader.place.findMany.mock.calls[0]?.[0].where).toMatchObject({
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      visibility: 'PUBLIC',
      isActive: true,
    })
  })
})
