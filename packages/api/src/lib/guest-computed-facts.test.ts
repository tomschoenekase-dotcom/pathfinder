import { describe, expect, it } from 'vitest'
import {
  admitGuestComputedSources,
  buildGuestComputedFacts,
  buildGuestComputedFactsForPrompt,
  compareRiderHeight,
  evaluateSubjectSchedule,
  guestComputedFactsMode,
  parseHeightRule,
  renderGuestComputedFacts,
  resolveRequestedDays,
} from './guest-computed-facts'

const now = new Date('2026-10-29T15:00:00Z')
const subject = { id: 'park', name: 'Briar Park', kind: 'venue' as const }
const input = {
  question: 'Open now?',
  resolvedSubject: subject,
  authorizedRecords: [
    {
      key: 'knowledge:hours',
      subjectId: 'park',
      kind: 'schedule' as const,
      content: 'Hours: Thursday 10 am to 6 pm.',
      version: 'v1',
    },
  ],
  sourceVersion: 'snapshot1',
  asOf: now,
  now,
  timeZone: 'America/Chicago',
  coverage: { fresh: true, complete: true },
  mode: 'all' as const,
}

describe('computed facts, fictional admitted records', () => {
  it('defaults off, rejects unknown flag values', () => {
    expect(guestComputedFactsMode({})).toBe('off')
    expect(guestComputedFactsMode({ GUEST_CHAT_COMPUTED_FACTS: 'yes' })).toBe('off')
    expect(guestComputedFactsMode({ GUEST_CHAT_COMPUTED_FACTS: 'schedule' })).toBe('schedule')
    expect(renderGuestComputedFacts(buildGuestComputedFacts({ ...input, mode: 'off' }))).toBe('')
  })
  it('calculates inclusive opening and exclusive closing, with no live claim', () => {
    const get = (date: string) =>
      buildGuestComputedFacts({ ...input, now: new Date(date) }).facts[0]
    expect(get('2026-10-29T14:59:00Z')).toMatchObject({ status: 'before_opening' })
    expect(get('2026-10-29T15:00:00Z')).toMatchObject({ status: 'open_by_schedule' })
    expect(get('2026-10-29T23:00:00Z')).toMatchObject({ status: 'after_closing' })
  })
  it.each([
    'Hours: Thursday 10 am to 6 pm; hours vary during private events.',
    'Gardens open dawn to dusk.',
    'Hours: Friday 10 pm to 2 am.',
    'Hours: Thursday 9 am to noon and 2 pm to 5 pm.',
  ])('abstains on the whole unsupported schedule: %s', (content) => {
    expect(
      buildGuestComputedFacts({
        ...input,
        authorizedRecords: [{ ...input.authorizedRecords[0]!, content }],
      }).facts,
    ).toEqual([])
  })
  it('closures override weekday hours and next opening remains bounded', () => {
    const packet = buildGuestComputedFacts({
      ...input,
      authorizedRecords: [
        {
          ...input.authorizedRecords[0]!,
          content: 'Hours: Thursday 10 am to 6 pm. Closed October 29, 2026.',
        },
      ],
    })
    expect(packet.facts[0]).toMatchObject({
      status: 'closed-date',
      nextOpening: { date: '2026-11-05', minute: 600 },
    })
  })
  it('rejects conflicts, stale/missing/partial snapshots and active updates', () => {
    for (const extra of [
      { coverage: { fresh: false, complete: true } },
      { coverage: { fresh: true, complete: false } },
      { activeUpdates: [{}] },
      { sourceVersion: '' },
      { resolvedSubject: null },
      {
        authorizedRecords: [
          ...input.authorizedRecords,
          { ...input.authorizedRecords[0]!, content: 'Hours: Thursday noon to 6 pm.' },
        ],
      },
    ])
      expect(buildGuestComputedFacts({ ...input, ...extra }).facts).toEqual([])
  })
  it('never inherits park hours for a cafe or a substring subject', () => {
    expect(
      buildGuestComputedFacts({
        ...input,
        resolvedSubject: { id: 'cafe', name: 'Lantern Cafe', kind: 'place' },
      }).facts,
    ).toEqual([])
  })
  it('preserves explicit year; future hours have no current verdict', () => {
    const packet = buildGuestComputedFacts({
      ...input,
      question: 'Hours October 29, 2027?',
      authorizedRecords: [
        { ...input.authorizedRecords[0]!, content: 'Hours: October 29, 2027, 11 am to 3 pm.' },
      ],
    })
    expect(packet.facts[0]).toMatchObject({
      date: '2027-10-29',
      status: 'posted_hours',
      open: 660,
      close: 900,
    })
  })
  it('resolves named weekday and rejects next-week ambiguity and invalid dates', () => {
    expect(
      resolveRequestedDays({ question: 'Hours Friday?', now, timeZone: input.timeZone }).dates,
    ).toEqual(['2026-10-30'])
    for (const question of [
      'Next Friday?',
      'Hours February 30, 2027?',
      'Hours Christmas?',
      'Open Friday at 1 pm?',
      'Hours 10/29/2027?',
      'Hours Sat Nov 29?',
      'Hours 2027?',
    ])
      expect(resolveRequestedDays({ question, now, timeZone: input.timeZone }).dates).toEqual([])
  })
  it('requires an absolute valid clock, retaining no local DST guesses', () => {
    expect(
      evaluateSubjectSchedule({
        content: 'Hours: daily 9 am to 5 pm.',
        subjectName: 'Briar Park',
        date: '2026-11-01',
        now: new Date('invalid'),
        timeZone: input.timeZone,
      }).status,
    ).toBe('unknown')
  })
  it('finds a known season opening beyond fourteen days without declaring permanence', () => {
    const result = evaluateSubjectSchedule({
      content:
        'The season opens November 21, 2026. Hours: daily 10 am to 6 pm during November 21, 2026 to December 31, 2026.',
      subjectName: 'Briar Park',
      date: '2026-10-29',
      now,
      timeZone: input.timeZone,
    })
    expect(result).toMatchObject({
      status: 'out-of-season',
      searchHorizonDays: 370,
      nextOpening: { date: '2026-11-21', minute: 600 },
    })
  })
  it('caps explicit requested days and reports omissions', () => {
    const question = `Hours ${Array.from({ length: 9 }, (_, n) => `2026-11-${String(n + 1).padStart(2, '0')}`).join(', ')}?`
    expect(resolveRequestedDays({ question, now, timeZone: input.timeZone })).toMatchObject({
      omittedDays: 1,
    })
    expect(resolveRequestedDays({ question, now, timeZone: input.timeZone }).dates).toHaveLength(8)
  })
  it('keeps source keys/version internally, excludes them from rendered data', () => {
    const packet = buildGuestComputedFacts(input)
    expect(packet.facts[0]).toMatchObject({
      sourceKeys: ['knowledge:hours'],
      sourceVersion: 'snapshot1',
      subjectId: 'park',
    })
    const rendered = renderGuestComputedFacts(packet)
    expect(rendered).toContain('open_by_schedule')
    expect(rendered).not.toContain('knowledge:hours')
  })
})

describe('prompt admission adapter', () => {
  const admitted = {
    mode: 'all' as const,
    question: 'Is Briar Park open now?',
    venue: { id: 'park', name: 'Briar Park' },
    places: [],
    identityPlaces: [],
    knowledge: [
      {
        id: 'hours',
        title: 'Opening hours',
        category: 'hours',
        content: 'Hours: Thursday 10 am to 6 pm.',
      },
    ],
    now,
    timeZone: 'America/Chicago',
    freshComplete: true,
    identityAmbiguous: false,
    activeUpdates: [],
  }
  it('uses FULL guide body admission while refusing directory, names-only, stale and mixed snapshots', () => {
    const guide = {
      guideMode: 'FULL' as const,
      guideRecordIds: new Set(['knowledge:hours']),
      rendererTruncated: false,
      freshComplete: true,
      dynamicPlaces: [],
      dynamicKnowledge: [],
      guidePlaces: [],
      guideKnowledge: admitted.knowledge,
    }
    const run = (override: Partial<typeof guide> = {}) =>
      buildGuestComputedFactsForPrompt({
        ...admitted,
        ...admitGuestComputedSources({ ...guide, ...override }),
        freshComplete: override.freshComplete ?? true,
        identityKnowledge: admitted.knowledge,
      })
    expect(run().facts[0]).toMatchObject({ subjectName: 'Briar Park', status: 'open_by_schedule' })
    for (const override of [
      { guideMode: 'DIRECTORY' },
      { guideMode: 'NONE' },
      { rendererTruncated: true },
      { guideRecordIds: new Set() },
      { freshComplete: false },
    ]) {
      const selected = admitGuestComputedSources({ ...guide, ...override } as Parameters<
        typeof admitGuestComputedSources
      >[0])
      expect(selected.knowledge).toEqual([])
      expect(
        buildGuestComputedFactsForPrompt({
          ...admitted,
          ...selected,
          identityKnowledge: admitted.knowledge,
          freshComplete: override.freshComplete ?? true,
        }).facts,
      ).toEqual([])
    }
    // Both stale rows and a native entry mixed with a legacy guide fail the router's same trust boolean.
    expect(run({ freshComplete: false }).facts).toEqual([])
  })
  it('prefers an admitted exact FULL body to an unchanged retrieved excerpt and keeps omitted bodies out', () => {
    const sources = admitGuestComputedSources({
      guideMode: 'FULL',
      guideRecordIds: new Set(['knowledge:hours']),
      rendererTruncated: false,
      freshComplete: true,
      dynamicPlaces: [],
      guidePlaces: [],
      dynamicKnowledge: [{ ...admitted.knowledge[0]!, content: 'truncated excerpt' }],
      guideKnowledge: [
        ...admitted.knowledge,
        {
          id: 'not-admitted',
          title: 'Extra',
          category: 'hours',
          content: 'Hours: daily noon to 6 pm.',
        },
      ],
    })
    expect(sources.knowledge).toEqual(admitted.knowledge)
  })
  it('computes named source facts for compound natural questions without classifying every word', () => {
    const packet = buildGuestComputedFactsForPrompt({
      ...admitted,
      question: 'Hi! Are you open today? We were thinking of coming with our children.',
    })
    expect(packet.facts).toContainEqual(
      expect.objectContaining({
        kind: 'schedule',
        subjectName: 'Briar Park',
        status: 'open_by_schedule',
      }),
    )
  })
  it('compares separately stated measurements against each admitted attraction topic', () => {
    const packet = buildGuestComputedFactsForPrompt({
      ...admitted,
      question: 'Our children are 100 cm and 128 cm. Which slides meet each height condition?',
      knowledge: [
        {
          id: 'slide',
          title: 'Silver Slide',
          category: 'attraction',
          content: 'Silver Slide is a curving slide. Riders must be at least 120 cm tall.',
        },
      ],
    })
    expect(packet.facts.filter((fact) => fact.kind === 'height')).toEqual([
      expect.objectContaining({
        subjectName: 'Silver Slide',
        riderHeight: '100 cm',
        status: 'below_minimum',
      }),
      expect.objectContaining({
        subjectName: 'Silver Slide',
        riderHeight: '128 cm',
        status: 'height_condition_met',
      }),
    ])
  })
  it('uses unique source identities for multiple requested rides rather than merge their conditions', () => {
    const rides = [
      {
        id: 'a',
        name: 'Silver Finch',
        hours: null,
        shortDescription: 'Height: 48 in minimum.',
        longDescription: null,
      },
      {
        id: 'b',
        name: 'Blue Finch',
        hours: null,
        shortDescription: 'Height: 54 in minimum.',
        longDescription: null,
      },
    ]
    const packet = buildGuestComputedFactsForPrompt({
      ...admitted,
      mode: 'height',
      question: 'Can my 50 inch child ride Silver Finch and Blue Finch?',
      places: rides,
      identityPlaces: rides,
    })
    expect(packet.facts).toEqual([
      expect.objectContaining({ subjectId: 'a', status: 'height_condition_met' }),
      expect.objectContaining({ subjectId: 'b', status: 'below_minimum' }),
    ])
  })
  it('keeps subject namespaces separate when venue and place IDs happen to match', () => {
    const cafe = {
      id: 'park',
      name: 'Lantern Cafe',
      hours: 'Hours: Thursday 11 am to 3 pm.',
      shortDescription: null,
      longDescription: null,
    }
    const packet = buildGuestComputedFactsForPrompt({
      ...admitted,
      places: [cafe],
      identityPlaces: [cafe],
    })
    expect(packet.facts).toEqual([
      expect.objectContaining({
        subjectKind: 'venue',
        subjectName: 'Briar Park',
        status: 'open_by_schedule',
      }),
      expect.objectContaining({
        subjectKind: 'place',
        subjectName: 'Lantern Cafe',
        status: 'before_opening',
      }),
    ])
  })
  it('keeps a labelled height condition with its whole raw source, preserving unresolved conditions', () => {
    const content =
      'Silver Finch is a family coaster.\nHeight: 48 in minimum.\nMaker: Fictional Works.'
    expect(compareRiderHeight(parseHeightRule(content), '50 in').status).toBe(
      'height_condition_met',
    )
    expect(parseHeightRule(content).raw).toBe(content)
    for (const extra of [
      'Age: 8 minimum.',
      'Under 50 inches needs an adult.',
      'A lower exception is unconfirmed.',
      'Manager approval can waive this limit.',
      'Ask before boarding.',
    ]) {
      expect(compareRiderHeight(parseHeightRule(`${content}\n${extra}`), '50 in').status).toBe(
        'unknown',
      )
    }
  })
  it('computes from an admitted whole topic, retaining its content hash', () => {
    const packet = buildGuestComputedFactsForPrompt(admitted)
    expect(packet.facts[0]).toMatchObject({ status: 'open_by_schedule', subjectId: 'park' })
    expect(packet.facts[0]?.recordVersions[0]).toMatch(/^[a-f0-9]{64}$/u)
  })
  it('cannot resurrect an omitted body or calculate from stale or rejected evidence', () => {
    for (const extra of [
      { knowledge: [] },
      { freshComplete: false },
      { identityAmbiguous: true },
      { activeUpdates: [{}] },
    ])
      expect(buildGuestComputedFactsForPrompt({ ...admitted, ...extra }).facts).toEqual([])
  })
  it('vetoes an omitted competing schedule without turning metadata into source proof', () => {
    expect(
      buildGuestComputedFactsForPrompt({
        ...admitted,
        identityKnowledge: [
          ...admitted.knowledge,
          { id: 'other-hours', title: 'Holiday hours', category: 'hours' },
        ],
      }).facts,
    ).toEqual([])
    expect(buildGuestComputedFactsForPrompt(admitted).facts[0]).toMatchObject({
      status: 'open_by_schedule',
    })
  })
  it('does not transfer venue hours to a named or unknown facility', () => {
    for (const question of [
      'Is Lantern Cafe open now?',
      'Is the cafe open now?',
      'Is it open now?',
    ])
      expect(
        buildGuestComputedFactsForPrompt({ ...admitted, question }).facts.every(
          (fact) => fact.subjectId === 'park',
        ),
      ).toBe(true)
    const cafe = {
      id: 'cafe',
      name: 'Lantern Cafe',
      hours: null,
      shortDescription: 'Menu: Tea.',
      longDescription: null,
    }
    expect(
      buildGuestComputedFactsForPrompt({
        ...admitted,
        question: 'Is Lantern Cafe open now?',
        places: [cafe],
        identityPlaces: [cafe],
      }).facts,
    ).toEqual([expect.objectContaining({ subjectId: 'park', subjectName: 'Briar Park' })])
  })
  it('keeps exact facility IDs and refuses substring/duplicate ambiguity', () => {
    const east = {
      id: 'east',
      name: 'East Garden',
      hours: 'Hours: Thursday 9 am to 5 pm.',
      shortDescription: null,
      longDescription: null,
    }
    const annex = {
      ...east,
      id: 'annex',
      name: 'East Garden Annex',
      hours: 'Hours: Thursday 11 am to 3 pm.',
    }
    const test = {
      ...admitted,
      question: 'Is East Garden Annex open now?',
      places: [east, annex],
      identityPlaces: [east, annex],
    }
    // Source-driven facts retain each exact subject rather than pick a substring match.
    expect(buildGuestComputedFactsForPrompt(test).facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId: 'east', status: 'open_by_schedule' }),
        expect.objectContaining({ subjectId: 'annex', status: 'before_opening' }),
      ]),
    )
    expect(
      buildGuestComputedFactsForPrompt({
        ...test,
        places: [annex],
        identityPlaces: [annex],
      }).facts.find((fact) => fact.subjectId === 'annex'),
    ).toMatchObject({ subjectId: 'annex', status: 'before_opening' })
    expect(
      buildGuestComputedFactsForPrompt({
        ...test,
        identityPlaces: [annex, { ...annex, id: 'other' }],
      }).facts,
    ).toEqual([expect.objectContaining({ subjectId: 'park' })])
  })
  it('does not accept generic park hours as explicitly scoped cafe hours', () => {
    const cafe = {
      id: 'cafe',
      name: 'Lantern Cafe',
      hours: 'The park opens Thursday 10 am to 6 pm.',
      shortDescription: null,
      longDescription: null,
    }
    expect(
      buildGuestComputedFactsForPrompt({
        ...admitted,
        question: 'Is Lantern Cafe open now?',
        places: [cafe],
        identityPlaces: [cafe],
      }).facts,
    ).toEqual([expect.objectContaining({ subjectId: 'park' })])
  })
  it('computes named rider condition only from its finally admitted body', () => {
    const ride = {
      id: 'finch',
      name: 'Silver Finch',
      hours: null,
      shortDescription: 'Height: 48 in minimum.',
      longDescription: null,
    }
    const test = {
      ...admitted,
      question: 'Can my 121 cm child ride Silver Finch?',
      places: [ride],
      identityPlaces: [ride],
    }
    expect(buildGuestComputedFactsForPrompt(test).facts[0]).toMatchObject({
      status: 'below_minimum',
      subjectId: 'finch',
    })
    expect(buildGuestComputedFactsForPrompt({ ...test, places: [] }).facts).toEqual([])
    expect(
      buildGuestComputedFactsForPrompt({
        ...test,
        places: [{ ...ride, longDescription: 'Age: 8 minimum.' }],
      }).facts,
    ).toEqual([])
  })
})

describe('exact height conditions', () => {
  it.each([
    ['47 in', 'below_minimum'],
    ['48 in', 'height_condition_met'],
    ['50 in', 'height_condition_met'],
    ['121 cm', 'below_minimum'],
    ['121.92 cm', 'height_condition_met'],
    ['4 ft 2 in', 'height_condition_met'],
  ])('compares %s to 48 inches without rounding', (height, status) => {
    expect(compareRiderHeight(parseHeightRule('Height: 48 in minimum.'), height).status).toBe(
      status,
    )
  })
  it.each([
    ['60 in', 'height_condition_met'],
    ['60.1 in', 'above_maximum'],
  ])('compares max %s', (height, status) => {
    expect(compareRiderHeight(parseHeightRule('Height: 32 to 60 in.'), height).status).toBe(status)
  })
  it.each([
    'Height: 36 in with an adult; 48 in to ride alone. Adult must be 18+.',
    'Height: 48 in minimum; a lower adult exception is unconfirmed.',
    'Height: under 48 in must wear a life vest.',
    'Height: no minimum; under 42 in with a supervising companion.',
    'Height: 48 in minimum; age 8 minimum.',
  ])('preserves unresolved whole rule and withholds verdict: %s', (raw) => {
    expect(parseHeightRule(raw).raw).toBe(raw)
    expect(compareRiderHeight(parseHeightRule(raw), '50 in').status).toBe('unknown')
  })
  it('compares multiple measurements separately and abstains for ride dimensions or age alone', () => {
    const heightInput = {
      ...input,
      resolvedSubject: { id: 'ride', name: 'Silver Finch', kind: 'place' as const },
      authorizedRecords: [
        {
          key: 'place:ride',
          subjectId: 'ride',
          kind: 'height' as const,
          content: 'Height: 48 in to ride.',
          version: 'v1',
        },
      ],
    }
    expect(
      buildGuestComputedFacts({
        ...heightInput,
        question: 'Can my 50 inch child ride Silver Finch?',
      }).facts[0],
    ).toMatchObject({ status: 'height_condition_met' })
    expect(
      buildGuestComputedFacts({
        ...heightInput,
        question: 'My children are 40 and 50 inches; which rides?',
      }).facts,
    ).toEqual([
      expect.objectContaining({ riderHeight: '40 inches', status: 'below_minimum' }),
      expect.objectContaining({ riderHeight: '50 inches', status: 'height_condition_met' }),
    ])
    for (const question of [
      'The tower is 120 ft. Can my 4 ft 2 in child ride?',
      'Can my 6 year old ride?',
    ])
      expect(buildGuestComputedFacts({ ...heightInput, question }).facts).toEqual([])
  })
})
