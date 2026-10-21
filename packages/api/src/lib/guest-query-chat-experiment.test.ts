import { describe, expect, it, vi } from 'vitest'
import {
  guestQueryChatExperimentEnabled,
  guestQuerySourcesAgree,
  prepareGuestChatQueryExperiment,
} from './guest-query-chat-experiment'
import type { GuestQuerySource } from './guest-query-source'
function source(): GuestQuerySource {
  return {
    tenantId: 'fictional-tenant',
    venueId: 'fictional-venue',
    version: 'v1',
    asOf: '2026-10-21T05:00:00.000Z',
    coverage: 'COMPLETE',
    readPath: 'LEGACY',
    includeSecondLayer: false,
    directory: {
      incomplete: false,
      searchVersion: 'v1',
      places: [
        {
          id: 'ride',
          name: 'Moon Ride',
          type: 'ATTRACTION',
          itemType: 'ride',
          shortDescription: null,
          longDescription:
            'Height at least 48 inches; under 10 with a paid adult. Booking does not waive restrictions.',
          lat: null,
          lng: null,
          tags: [],
          areaName: 'North',
          hours: null,
          photoUrl: null,
          sourceType: 'MANUAL',
          sourceName: null,
          sourceUrl: null,
        },
      ],
      knowledge: [
        {
          id: 'policy',
          title: 'Moon Ride booking',
          category: 'POLICY',
          content:
            'Weekends only; each rider pays $8. Closed October 20–22. Reservations do not waive restrictions.',
          sourceType: 'MANUAL',
          sourceName: null,
          sourceUrl: null,
        },
      ],
    },
  }
}
const plan = (predicates: unknown[]) =>
  JSON.stringify({ status: 'QUERY', mode: 'list', predicates })
const kind = { field: 'kind', equals: 'ATTRACTION' }
describe('local structured chat experiment boundary', () => {
  it('rejects differing same-ID bodies while allowing equal duplicates and new IDs', () => {
    const previous = [{ id: 'same', content: 'Old whole body', title: 'Topic' }]
    expect(guestQuerySourcesAgree(previous, [{ ...previous[0]! }])).toBe(true)
    const independent = [{ id: 'new', content: 'New independent body' }]
    const changed = [{ id: 'same', content: 'New whole body' }]
    expect(guestQuerySourcesAgree(previous, independent)).toBe(true)
    expect(guestQuerySourcesAgree(previous, changed)).toBe(false)
  })
  it.each([
    [
      { nodeEnv: 'test', enabled: undefined, experienceScope: 'PUBLIC', nativePath: 'LEGACY' },
      false,
    ],
    [
      { nodeEnv: 'production', enabled: '1', experienceScope: 'PUBLIC', nativePath: 'LEGACY' },
      false,
    ],
    [{ nodeEnv: 'test', enabled: '1', experienceScope: 'PUBLIC', nativePath: 'NATIVE' }, false],
    [
      { nodeEnv: 'test', enabled: '1', experienceScope: 'SECOND_LAYER', nativePath: 'LEGACY' },
      false,
    ],
    [{ nodeEnv: 'test', enabled: '1', experienceScope: 'PUBLIC', nativePath: 'LEGACY' }, true],
    [{ nodeEnv: 'development', enabled: '1', experienceScope: 'PUBLIC', nativePath: 'DARK' }, true],
  ])('gates explicit local admission %#', (input, expected) =>
    expect(guestQueryChatExperimentEnabled(input)).toBe(expected),
  )
  it('retains complete matching and context conditions with exact original bodies', async () => {
    const original = source()
    const interpret = vi.fn(async () => plan([kind]))
    const result = await prepareGuestChatQueryExperiment({
      source: original,
      question: 'List attractions',
      interpret,
    })
    expect(result.status).toBe('READY')
    if (result.status !== 'READY') return
    expect(result.partial).toBe(false)
    expect(result.places).toEqual(original.directory.places)
    expect(result.knowledge).toEqual(original.directory.knowledge)
    const rendered = JSON.parse(result.prompt.split('\n').at(-1)!)
    expect(JSON.parse(rendered.rows[0].sourceText)).toEqual(original.directory.places[0])
    expect(JSON.parse(rendered.context[0].text)).toEqual(original.directory.knowledge[0])
    expect(interpret).toHaveBeenCalledOnce()
  })
  it.each([
    plan([kind, { field: 'feature', name: 'wheelchairAccessible', value: true }]),
    plan([
      { field: 'name', equals: 'Moon Ride' },
      { field: 'product', name: 'pizza' },
    ]),
    JSON.stringify({ status: 'UNSUPPORTED', reason: 'Age and date conditions unsupported' }),
    'invalid JSON',
    plan([]),
  ])('falls back for whole unsupported or invalid conjunct plans %#', async (raw) => {
    const interpret = vi.fn(async () => raw)
    const result = await prepareGuestChatQueryExperiment({
      source: source(),
      question: 'Attractions for a nine year old today',
      interpret,
    })
    expect(result.status).toBe('BASELINE')
    expect(result).not.toHaveProperty('prompt')
    expect(interpret).toHaveBeenCalledOnce()
  })
  it('propagates pre-completion gateway/accounting failure without retry', async () => {
    const interpret = vi.fn(async () => {
      throw new Error('accounting rejected')
    })
    await expect(
      prepareGuestChatQueryExperiment({
        source: source(),
        question: 'List attractions',
        interpret,
      }),
    ).rejects.toThrow('accounting rejected')
    expect(interpret).toHaveBeenCalledOnce()
  })
  it('copies authoritative inputs before callback mutation', async () => {
    const original = source()
    const before = structuredClone(original)
    const result = await prepareGuestChatQueryExperiment({
      source: original,
      question: 'List attractions',
      interpret: async () => {
        original.directory.places = []
        original.directory.knowledge = []
        return plan([kind])
      },
    })
    expect(result.status).toBe('READY')
    if (result.status === 'READY') {
      expect(result.places).toEqual(before.directory.places)
      expect(result.knowledge).toEqual(before.directory.knowledge)
    }
  })
  it('reports omitted oversized context whole instead of retaining a condition fragment', async () => {
    const original = source()
    original.directory.knowledge[0]!.content =
      'WHOLE_CONDITION_START ' + 'x'.repeat(35000) + ' WHOLE_CONDITION_END'
    const result = await prepareGuestChatQueryExperiment({
      source: original,
      question: 'List attractions',
      interpret: async () => plan([kind]),
    })
    expect(result).toEqual({ status: 'BASELINE', reason: 'INCOMPLETE_SOURCE_CONTEXT' })
    expect(result).not.toHaveProperty('prompt')
  })
})
