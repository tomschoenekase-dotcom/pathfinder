// PROPOSED actual-owner tests: UNRUN until root opens a runtime/source window.
import { describe, expect, it, vi } from 'vitest'
import * as venueContext from './venue-context'
import { guestFacetIndex, selectGuestFacetCollection } from './guest-facet-integration'
import { facetUnionCannotFit } from './guest-facet-union-bound'
import { selectFacetRecords } from './guest-facet-evidence'
import type {
  GuestDirectoryKnowledge,
  GuestDirectoryPlace,
  GuestVenueDirectory,
} from './guest-venue-directory'

const knowledge = (id: string, content: string): GuestDirectoryKnowledge => ({
  id,
  title: `Fictional topic ${id}`,
  category: 'GENERAL',
  content,
  sourceType: 'MANUAL',
  sourceName: 'Fictional source',
  sourceUrl: null,
})
const place = (id: string): GuestDirectoryPlace => ({
  id,
  name: `Fictional place ${id}`,
  type: 'ATTRACTION',
  itemType: null,
  shortDescription: 'A fictional recorded place.',
  longDescription: 'A whole recorded condition remains here.',
  lat: null,
  lng: null,
  tags: ['ride'],
  areaName: null,
  hours: null,
  photoUrl: null,
  sourceType: 'MANUAL',
  sourceName: 'Fictional source',
  sourceUrl: null,
})
const originalRender = venueContext.buildVenueSystemPromptParts
const measure = (k: GuestDirectoryKnowledge[], p: GuestDirectoryPlace[]) =>
  originalRender({
    venue: { name: '', description: null, category: null },
    relevantPlaces: p,
    knowledgeEntries: k,
    userLat: null,
    userLng: null,
  }).recordContext.chars

function oldSelection(directory: GuestVenueDirectory, maxChars: number) {
  const index = guestFacetIndex(directory, '2026-10-20')
  const all = selectFacetRecords({
    records: index,
    constraints: {},
    governingKeys: [],
    maxChars: Number.MAX_SAFE_INTEGER,
  })
  const required = new Set(all.requiredKeys)
  const actualChars = measure(
    directory.knowledge.filter((r) => required.has(`knowledge:${r.id}`)),
    directory.places.filter((r) => required.has(`place:${r.id}`)),
  )
  return actualChars <= maxChars && all.selectionComplete
    ? all
    : selectFacetRecords({ records: index, constraints: {}, governingKeys: [], maxChars })
}

describe('finite union overflow lower bound', () => {
  it('preserves exact selections and source objects for fit, boundary and proven overflow', () => {
    for (const count of [0, 1, 4, 31, 200]) {
      const directory: GuestVenueDirectory = {
        knowledge: Array.from({ length: count }, (_, i) =>
          knowledge(String(i), 'Fictional whole body and condition. '.repeat(count > 31 ? 20 : 1)),
        ),
        places: count < 31 ? Array.from({ length: count }, (_, i) => place(String(i))) : [],
        incomplete: false,
        searchVersion: `union-bound-proposed-${count}`,
      }
      const before = JSON.stringify(directory)
      const exact = measure(directory.knowledge, directory.places)
      for (const maxChars of [0, Math.max(0, exact - 1), exact, exact + 1, 30_000]) {
        const expected = oldSelection(directory, maxChars)
        const result = selectGuestFacetCollection({
          directory,
          currentDate: '2026-10-20',
          constraints: {},
          governingKeys: [],
          maxChars,
        })
        expect(result.selection).toEqual(expected)
        expect(result.knowledge.map((r) => r.id)).toEqual(
          expected.selectedKeys
            .filter((k) => k.startsWith('knowledge:'))
            .map((k) => k.slice('knowledge:'.length)),
        )
        for (const row of result.knowledge) expect(directory.knowledge).toContain(row)
        for (const row of result.places) expect(directory.places).toContain(row)
        expect(JSON.stringify(directory)).toBe(before)
      }
    }
  })

  it('does not render the whole oversized union on a warm index hit', () => {
    const directory: GuestVenueDirectory = {
      knowledge: Array.from({ length: 200 }, (_, i) =>
        knowledge(String(i), 'Whole fictional text with a preserved condition. '.repeat(20)),
      ),
      places: [],
      incomplete: false,
      searchVersion: 'union-bound-proposed-warm-oversized',
    }
    const expected = oldSelection(directory, 30_000)
    const spy = vi.spyOn(venueContext, 'buildVenueSystemPromptParts')
    try {
      const result = selectGuestFacetCollection({
        directory,
        currentDate: '2026-10-20',
        constraints: {},
        governingKeys: [],
        maxChars: 30_000,
      })
      expect(result.selection).toEqual(expected)
      expect(
        spy.mock.calls.some(
          ([args]) => (args.knowledgeEntries?.length ?? 0) + args.relevantPlaces.length === 200,
        ),
      ).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('proves actual renderer lower bounds across Unicode, null fields, URLs and ordinal width', () => {
    const emptyK = { ...knowledge('', ''), title: '' }
    const emptyP = {
      ...place(''),
      name: '',
      shortDescription: null,
      longDescription: null,
      tags: [],
      hours: null,
    }
    const overhead = Math.max(measure([emptyK], []), measure([], [emptyP]))
    const texts = ['', 'e\u0301', '\u00e9', '<>&\u2028\u2029', '\uD800', 'line1\r\nline2']
    for (const [i, text] of texts.entries()) {
      const k = Array.from({ length: 12 }, (_, n) => ({
        ...knowledge(`${i}-${n}`, text),
        title: text,
        sourceUrl: n % 2 ? 'https://example.test/a?x=1&y=2' : 'https://example.test/?token=refused',
      }))
      const p = Array.from({ length: 103 }, (_, n) => ({
        ...place(`${i}-${n}`),
        name: text,
        shortDescription: n % 2 ? null : text,
        hours: n % 3 ? null : text,
        tags: n % 2 ? [] : [text],
      }))
      const records = [
        ...k.map((row) => ({ key: `knowledge:${row.id}`, chars: measure([row], []) })),
        ...p.map((row) => ({ key: `place:${row.id}`, chars: measure([], [row]) })),
      ]
      const keys = new Set(records.map((row) => row.key))
      const exact = measure(k, p)
      expect(facetUnionCannotFit(records, keys, exact, overhead)).toBe(false)
      const lower = records.reduce((sum, row) => sum + Math.max(0, row.chars - overhead), 0)
      expect(lower).toBeLessThanOrEqual(exact)
      if (lower > 0) expect(facetUnionCannotFit(records, keys, lower - 1, overhead)).toBe(true)
    }
  })
})
