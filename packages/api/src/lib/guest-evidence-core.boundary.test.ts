import { describe, expect, it, vi } from 'vitest'
import {
  renderGuestVenueIndex,
  selectGuestVenueIndexCoreKnowledge,
  reconcileGuestVenueIndexCoreKnowledge,
  prepareGuestVenueIndexCoreKnowledge,
} from './guest-venue-index'
import {
  revalidateGuestQuestionEvidence,
  selectGuestQuestionEvidence,
} from './guest-question-evidence'
import type { GuestDirectoryKnowledge, GuestVenueDirectory } from './guest-venue-directory'

const currentDate = '2026-10-20'
const stamp = new Date('2026-10-01')
function core(id: string, extra: Partial<GuestDirectoryKnowledge> = {}): GuestDirectoryKnowledge {
  return {
    id,
    title: `Synthetic core ${id}`,
    category: 'ADMISSION',
    content:
      'Admission requires advance booking. Children under eight need an adult. After 6pm, booking must be made the previous day.',
    sourceType: 'MANUAL',
    sourceName: null,
    sourceUrl: null,
    updatedAt: stamp,
    ...extra,
  }
}
function directory(knowledge: GuestDirectoryKnowledge[]): GuestVenueDirectory {
  return { knowledge, places: [], incomplete: false, searchVersion: 'synthetic-version' }
}
const select = (value: GuestVenueDirectory) =>
  selectGuestVenueIndexCoreKnowledge(value, { currentDate })
const reconcile = (
  value: GuestVenueDirectory,
  selected: GuestDirectoryKnowledge[],
  current: GuestDirectoryKnowledge[],
) => reconcileGuestVenueIndexCoreKnowledge({ directory: value, selected, current })
const render = (value: GuestVenueDirectory, current: GuestDirectoryKnowledge[]) =>
  renderGuestVenueIndex(value, { currentDate, coreKnowledge: current })

describe('whole core policy selection independent boundaries', () => {
  it.each(['hours', '  OPENING   HOURS  ', 'Operating Hours', ' admission '])(
    'admits the exact normalized category %s with all conditions',
    (category) => {
      const row = core('whole', { category })
      const value = directory([row])
      expect(select(value).map((item) => item.id)).toEqual(['whole'])
      const index = render(value, select(value))
      expect(index.prompt).toContain(row.content)
      expect(index.recordIds).toEqual(new Set(['knowledge:whole']))
      expect(index.prompt.length).toBeLessThanOrEqual(12_000)
    },
  )

  it.each([
    'admissions',
    'admission rules',
    'extended hours',
    'opening hours notes',
    'tickets',
    'hours/admission',
  ])('rejects the near category %s', (category) => {
    const row = core('near', { category })
    const value = directory([row])
    expect(select(value)).toEqual([])
    const index = renderGuestVenueIndex(value, { currentDate })
    expect(index.prompt).not.toContain(row.content)
    expect(index.recordIds.size).toBe(0)
  })

  it('does not spend core budget on past events and retains ambiguous-year markers', () => {
    const past = core('past', {
      title: 'Admission festival 2024',
      content: 'Held in October 2024.',
    })
    const ambiguous = core('ambiguous', {
      title: 'Admission festival 2025',
      content: 'A new run is planned in 2026. Confirm its dates.',
    })
    const value = directory([past, ambiguous])
    expect(select(value).map((item) => item.id)).toEqual(['ambiguous'])
    const index = render(value, select(value))
    expect(index.recordIds).toEqual(new Set(['knowledge:ambiguous']))
    expect(index.prompt).not.toContain(past.content)
    expect(index.prompt).toContain('title_year_passed')
  })

  it('measures the four-thousand core bound after escaping and skips oversized bodies whole', () => {
    const huge = core('huge', { content: `OVERSIZE_START_${'<&>'.repeat(600)}_OVERSIZE_END` })
    const small = core('small')
    const value = directory([huge, small])
    expect(select(value).map((item) => item.id)).toEqual(['small'])
    const index = render(value, [huge, small])
    expect(index.prompt).not.toContain('OVERSIZE_START_')
    expect(index.prompt).toContain(small.content)
    expect(index.recordIds).toEqual(new Set(['knowledge:small']))
    expect(index.prompt.length).toBeLessThanOrEqual(12_000)
  })
})

describe('core authority race reconciliation independent boundaries', () => {
  it.each([
    ['100k growth', { content: `GROWN_START_${'grown '.repeat(17_000)}_GROWN_END` }],
    ['reclassification', { category: 'ADMISSION NOTES', content: 'RECLASSIFIED_BODY' }],
  ] as const)(
    'removes %s from every downstream lane before rendering or selection',
    (_label, changed) => {
      const old = core('racing', { content: 'STALE_PREDECESSOR_BODY' })
      const fallback = core('unvalidated', { content: 'UNVALIDATED_FALLBACK_BODY' })
      const next = prepareGuestVenueIndexCoreKnowledge({
        directory: directory([old, fallback]),
        selected: [old],
        current: [{ ...old, ...changed }, core('unexpected')],
        relevantKnowledgeEntries: [{ ...old, distance: 0.1 }],
        currentDate,
      })
      expect(next.directory.knowledge.map((row) => row.id)).toEqual(['unvalidated'])
      expect(next.directory.incomplete).toBe(true)
      expect(next.directory.searchVersion).toBeUndefined()
      expect(next.coreKnowledge).toEqual([])
      expect(next.relevantKnowledgeEntries).toEqual([])
      const index = render(next.directory, next.coreKnowledge)
      expect(index.prompt).not.toContain('STALE_PREDECESSOR_BODY')
      expect(index.prompt).not.toContain('UNVALIDATED_FALLBACK_BODY')
      expect(index.prompt).not.toContain('GROWN_START_')
      expect(index.prompt).not.toContain('RECLASSIFIED_BODY')
      expect(index.recordIds.size).toBe(0)
    },
  )

  it('replaces already retrieved core without losing retrieval metadata or unaffected rows', () => {
    const old = core('racing')
    const unrelated = core('unrelated', { category: 'EXHIBITS' })
    const current = { ...old, content: 'CURRENT_WHOLE_POLICY', updatedAt: stamp }
    const next = prepareGuestVenueIndexCoreKnowledge({
      directory: directory([old, unrelated]),
      selected: [old],
      current: [current, core('unexpected')],
      relevantKnowledgeEntries: [
        { ...old, distance: 0.25 },
        { ...unrelated, distance: 0.5 },
      ],
      currentDate,
    })
    expect(next.directory.searchVersion).toBeUndefined()
    expect(next.directory.incomplete).toBe(false)
    expect(next.coreKnowledge).toEqual([current])
    expect(next.relevantKnowledgeEntries).toEqual([
      { ...current, distance: 0.25 },
      { ...unrelated, distance: 0.5 },
    ])
  })

  it('withdraws selected core from all lanes without an artificial source coverage gap', () => {
    const old = core('withdrawn')
    const next = prepareGuestVenueIndexCoreKnowledge({
      directory: directory([old]),
      selected: [old],
      current: [],
      relevantKnowledgeEntries: [old],
      currentDate,
    })
    expect(next.directory.knowledge).toEqual([])
    expect(next.directory.incomplete).toBe(false)
    expect(next.directory.searchVersion).toBeUndefined()
    expect(next.coreKnowledge).toEqual([])
    expect(next.relevantKnowledgeEntries).toEqual([])
  })
  it('replaces an edited same-ID body throughout the directory and invalidates the old term identity', () => {
    const old = core('policy', { content: 'Old zephyr admission policy.' })
    const value = directory([old])
    // Prime the question selector's postings with the previous body/version.
    selectGuestQuestionEvidence({
      query: 'zephyr?',
      directory: value,
      mode: 'DIRECTORY',
      currentDate,
      knowledgeInContext: [],
      placesInContext: [],
    })
    const current = {
      ...old,
      content: 'Current quetzal admission requires booking after 6pm.',
      updatedAt: stamp,
    }
    const next = reconcile(value, [old], [current])
    expect(value.knowledge[0]?.content).toBe(old.content)
    expect(next.knowledge[0]?.content).toBe(current.content)
    expect(next.searchVersion).toBeUndefined()
    const selected = selectGuestQuestionEvidence({
      query: 'quetzal admission?',
      directory: next,
      mode: 'DIRECTORY',
      currentDate,
      knowledgeInContext: [],
      placesInContext: [],
    })
    expect(selected.knowledge.find((row) => row.id === old.id)?.content).toBe(current.content)
    expect(render(next, [current]).prompt).not.toContain(old.content)
  })

  it('does not admit an unvalidated fallback after withdrawal frees the core budget', () => {
    const chosen = core('chosen', { content: `CHOSEN_ONLY_${'x'.repeat(2900)}` })
    const fallback = core('fallback', { content: `UNVALIDATED_FALLBACK_${'z'.repeat(1600)}` })
    const value = directory([chosen, fallback])
    const selected = select(value)
    expect(selected.map((row) => row.id)).toEqual(['chosen'])
    const next = reconcile(value, selected, [])
    expect(next.knowledge.map((row) => row.id)).toEqual(['fallback'])
    expect(next.searchVersion).toBeUndefined()
    const index = render(next, [])
    expect(index.prompt).not.toContain('CHOSEN_ONLY_')
    expect(index.prompt).not.toContain('UNVALIDATED_FALLBACK_')
    expect(index.recordIds.size).toBe(0)
  })

  it('omits a newly oversized current policy whole without reviving its short old body', () => {
    const old = core('growing')
    const current = {
      ...old,
      content: `CURRENT_LONG_BEGIN_${'lengthy '.repeat(1000)}_CURRENT_LONG_END`,
    }
    const next = reconcile(directory([old]), [old], [current])
    expect(next.knowledge[0]?.content).toBe(current.content)
    const index = render(next, [current])
    expect(index.prompt).not.toContain(old.content)
    expect(index.prompt).not.toContain('CURRENT_LONG_BEGIN_')
    expect(index.recordIds.size).toBe(0)
  })

  it('reclassifies a live category change without sending the old or new body as core', () => {
    const old = core('reclassified')
    const current = { ...old, category: 'ADMISSION NOTES', content: 'NEW_NONCORE_BODY' }
    const next = reconcile(directory([old]), [old], [current])
    const index = render(next, [current])
    expect(next.searchVersion).toBeUndefined()
    expect(index.prompt).not.toContain(old.content)
    expect(index.prompt).not.toContain(current.content)
    expect(index.recordIds.size).toBe(0)
  })

  it('preserves identity for unchanged bodies and ignores unexpected returned IDs', () => {
    const old = core('selected')
    const untouched = core('untouched', { category: 'EXHIBITS' })
    const value = directory([old, untouched])
    expect(reconcile(value, [old], [{ ...old }, core('unexpected')])).toBe(value)
    const next = reconcile(value, [old], [])
    expect(next.knowledge).toEqual([untouched])
    expect(next.searchVersion).toBeUndefined()
  })

  it('fails closed when the live body read rejects, including an empty validated-core override', async () => {
    const old = core('failed-read')
    const value = directory([old])
    const reader = {
      venueKnowledgeEntry: {
        findMany: vi.fn().mockRejectedValue(new Error('synthetic authority read failure')),
      },
    }
    await expect(
      revalidateGuestQuestionEvidence({
        reader,
        tenantId: 'synthetic-tenant',
        venueId: 'synthetic-venue',
        includeSecondLayer: false,
        asOf: new Date('2026-10-20'),
        currentDate,
        knowledge: [old],
      }),
    ).rejects.toThrow('synthetic authority read failure')
    // Chat's explicitly specified fail-closed state must remain safe through reconcile+render.
    const next = reconcile(value, [old], [])
    const index = render(next, [])
    expect(index.prompt).not.toContain(old.content)
    expect(index.recordIds.size).toBe(0)
    expect(next.searchVersion).toBeUndefined()
  })
})
