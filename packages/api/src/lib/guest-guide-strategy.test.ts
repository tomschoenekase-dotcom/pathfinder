import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { GuestVenueDirectory } from './guest-venue-directory'
import { buildGuestVenueGuidePrompt, staleGuestGuideRecordIds } from './guest-venue-directory'
import {
  addExplicitGuestGuideRecords,
  buildGuestGuideStrategy,
  useTieredGuestGuide,
} from './guest-guide-strategy'
import { buildGuestGuideCoverage } from './guest-guide-coverage'

const directory: GuestVenueDirectory = {
  incomplete: false,
  places: [
    {
      id: 'ride',
      name: 'Thunderbolt',
      type: 'ATTRACTION',
      itemType: null,
      shortDescription: 'A steel coaster.',
      longDescription: 'A steel coaster with a long story.',
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
      id: 'ride-facts',
      title: 'Thunderbolt: ride facts',
      category: 'Rides',
      content:
        'A steel roller coaster.\nAlso called: Lightning; The Bolt\nMade by: Fictional Works\n' +
        'Detailed history. '.repeat(120),
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
      updatedAt: new Date('2026-01-01'),
    },
    {
      id: 'parking',
      title: 'Parking',
      category: 'Planning',
      content: 'Parking is on the east side.\nAlso called: Car park',
      sourceType: 'MANUAL',
      sourceName: null,
      sourceUrl: null,
    },
  ],
}

const expand = (question: string, previousQuestion?: string) =>
  addExplicitGuestGuideRecords({
    directory,
    question,
    ...(previousQuestion === undefined ? {} : { previousQuestion }),
    places: [],
    knowledgeEntries: [],
  })

describe('guest guide strategy', () => {
  it.each([undefined, '', '0', 'true', '01'])('keeps flag %s disabled', (flag) =>
    expect(useTieredGuestGuide(flag, 'ECONOMY')).toBe(false),
  )
  it.each([undefined, 'STANDARD', 'PREMIUM'])('rejects primary tier %s', (tier) =>
    expect(useTieredGuestGuide('1', tier)).toBe(false),
  )
  it('enables the economy primary only with the exact flag', () =>
    expect(useTieredGuestGuide('1', 'ECONOMY')).toBe(true))
  it.each([undefined, 1])(
    'preserves the legacy guide bytes including directory fallback (%s)',
    (maxFullChars) => {
      const options = { currentDate: '2026-10-13', ...(maxFullChars === undefined ? {} : { maxFullChars }) }
      expect(buildGuestGuideStrategy(directory, { ...options, tiered: false })).toEqual(
        buildGuestVenueGuidePrompt(directory, options),
      )
    },
  )
  it('keeps tiered detail IDs empty and proves the index hash in evidence and coverage', () => {
    const guide = buildGuestGuideStrategy(directory, { currentDate: '2026-10-13', tiered: true })
    expect(guide.mode).toBe('TIERED')
    expect(guide.recordIds.size).toBe(0)
    expect(guide.prompt).toContain('VENUE INDEX:')
    expect(guide.prompt).not.toContain('Detailed history.')
    const hash = createHash('sha256').update(guide.prompt).digest('hex')
    expect(guide.indexSha256).toBe(hash)
    expect(guide.evidenceText).toContain(hash)
    expect(
      buildGuestGuideCoverage({ guide, directory, loadStatus: 'READY', projectionPath: 'LEGACY' }),
    ).toMatchObject({ mode: 'TIERED', promptSha256: hash, includedDetailCount: 0 })
  })
  it.each(['Thunderbolt', 'LIGHTNING', 'The Bolt'])(
    'adds explicitly named ride %s in full',
    (name) => {
      const result = expand(`Tell me about ${name}?`)
      expect(result.places.map((place) => place.id)).toEqual(['ride'])
      expect(result.knowledgeEntries[0]?.content).toBe(directory.knowledge[0]!.content)
    },
  )
  it('adds a generic one-word topic explicitly named by the visitor', () =>
    expect(expand('Where is Parking?').knowledgeEntries.map((entry) => entry.id)).toEqual([
      'parking',
    ]))
  it('finds aliases in the previous visitor question for follow-ups', () =>
    expect(expand('Who made it?', 'How fast is Lightning?').knowledgeEntries[0]?.id).toBe(
      'ride-facts',
    ))
  it('does not carry the previous ride into a new explicitly named topic', () => {
    const result = expand('Where is Parking?', 'How fast is Lightning?')
    expect(result.places).toEqual([])
    expect(result.knowledgeEntries.map((entry) => entry.id)).toEqual(['parking'])
  })
  it('switches subjects on an explicitly named what-about follow-up', () => {
    expect(expand('What about Parking?', 'Lightning?').knowledgeEntries.map((entry) => entry.id)).toEqual(['parking'])
  })
  it('keeps the previous subject in an explicit pronoun comparison', () => {
    expect(expand('Compare it with Parking?', 'Lightning?').knowledgeEntries.map((entry) => entry.id)).toEqual(['ride-facts', 'parking'])
  })
  it('keeps both explicitly named subjects in a compound maker question', () => {
    const result = expand('Who made Lightning, and where is the Car park?')
    expect(result.knowledgeEntries.map((entry) => entry.id)).toEqual(['ride-facts', 'parking'])
  })
  it('retains an explicitly negated subject as evidence without interpreting the negation', () => {
    expect(expand('Is Lightning not made by Fictional Works?').knowledgeEntries[0]?.id).toBe('ride-facts')
  })
  it('links facts to a place whose own name has a directory suffix', () => {
    const result = addExplicitGuestGuideRecords({
      directory: { ...directory, places: [{ ...directory.places[0]!, name: 'Thunderbolt: attraction' }] },
      question: 'Tell me about Thunderbolt?', places: [], knowledgeEntries: [],
    })
    expect(result.places.map((place) => place.id)).toEqual(['ride'])
    expect(result.knowledgeEntries.map((entry) => entry.id)).toEqual(['ride-facts'])
  })
  it.each([
    ['Who made Thunderbolt Falls?', ['falls-facts']],
    ['Compare Thunderbolt and Thunderbolt Falls', ['ride-facts', 'falls-facts']],
  ])('resolves overlapping proper names in %s', (question, expectedIds) => {
    const result = addExplicitGuestGuideRecords({
      directory: { ...directory, knowledge: [...directory.knowledge, {
        ...directory.knowledge[0]!, id: 'falls-facts', title: 'Thunderbolt Falls: ride facts',
        content: 'Made by: Water Works',
      }] }, question, places: [], knowledgeEntries: [],
    })
    expect(result.knowledgeEntries.map((entry) => entry.id)).toEqual(expectedIds)
  })
  it('does not match a name inside another word', () =>
    expect(expand('Thunderbolts and Lightningbug').knowledgeEntries).toEqual([]))
  it('preserves the selected ID after upstream same-name location resolution', () => {
    const north = { ...directory.places[0]!, id: 'north-restroom', name: 'Restroom', areaName: 'North' }
    const south = { ...north, id: 'south-restroom', areaName: 'South' }
    const result = addExplicitGuestGuideRecords({ directory: { incomplete: false, knowledge: [], places: [north, south] },
      question: 'Where is the South Restroom?', places: [south], knowledgeEntries: [],
    })
    expect(result.places.map((place) => place.id)).toEqual(['south-restroom'])
  })
  it('keeps unresolved same-name places as distinct candidates', () => {
    const places = ['North', 'South'].map((areaName) => ({ ...directory.places[0]!, id: areaName, name: 'Restroom', areaName }))
    const result = addExplicitGuestGuideRecords({ directory: { incomplete: false, knowledge: [], places },
      question: 'Where is the Restroom?', places: [], knowledgeEntries: [],
    })
    expect(result.places.map((place) => place.id)).toEqual(['North', 'South'])
  })
  it('does not add an excluded same-name location topic after identity resolution', () => {
    const places = ['North', 'South'].map((areaName) => ({ ...directory.places[0]!, id: areaName,
      name: 'Lantern Loop', areaName, sourceUrl: `https://lantern.example/${areaName.toLowerCase()}/`,
    }))
    const knowledge = ['North', 'South'].map((areaName) => ({ ...directory.knowledge[0]!, id: `${areaName}-rules`,
      title: `Lantern Loop: ${areaName} rider rules`, content: `Height: ${areaName === 'North' ? 36 : 52} inches minimum`,
      sourceUrl: `https://lantern.example/${areaName.toLowerCase()}/`,
    }))
    knowledge.push({ ...knowledge[0]!, id: 'shared-facts', title: 'Lantern Loop: ride facts', content: 'Made by: Fictional Works' })
    const result = addExplicitGuestGuideRecords({ directory: { incomplete: false, places, knowledge },
      question: 'Can my 40 inch child ride Lantern Loop in North?', places: [places[0]!],
      knowledgeEntries: [{ ...knowledge[0]!, distance: 0.1 }],
    })
    expect(result.knowledgeEntries.map((entry) => entry.id)).toEqual(['North-rules', 'shared-facts'])
    expect(result.knowledgeEntries[0]).toMatchObject({ content: knowledge[0]!.content, sourceUrl: knowledge[0]!.sourceUrl })
  })
  it('expands retrieved excerpts without duplicating records', () => {
    const entry = { ...directory.knowledge[0]!, content: 'excerpt', distance: 0.2 }
    const result = addExplicitGuestGuideRecords({
      directory,
      question: 'Thunderbolt',
      places: directory.places,
      knowledgeEntries: [entry],
    })
    expect(result.places).toHaveLength(1)
    expect(result.knowledgeEntries).toHaveLength(1)
    expect(result.knowledgeEntries[0]?.content).toBe(directory.knowledge[0]!.content)
    expect(result.knowledgeEntries[0]?.distance).toBe(0.2)
  })
  it('preserves an intentionally cleared live long description', () => {
    const result = addExplicitGuestGuideRecords({
      directory,
      question: 'Thunderbolt',
      places: [{ ...directory.places[0]!, longDescription: null }],
      knowledgeEntries: [],
    })
    expect(result.places[0]?.longDescription).toBeNull()
  })
  it('fills an omitted long description without treating null as omission', () => {
    const result = addExplicitGuestGuideRecords({ directory, question: 'Thunderbolt',
      places: [{ ...directory.places[0]!, longDescription: undefined } as unknown as (typeof directory.places)[number]],
      knowledgeEntries: [],
    })
    expect(result.places[0]?.longDescription).toBe(directory.places[0]!.longDescription)
  })
  it.each([
    { shortDescription: null },
    { name: 'New operator name' },
  ])('does not refill a changed live place from cached details (%j)', (change) => {
    const result = addExplicitGuestGuideRecords({ directory, question: 'Thunderbolt',
      places: [{ ...directory.places[0]!, ...change, longDescription: null }], knowledgeEntries: [],
    })
    expect(result.places[0]?.longDescription).toBeNull()
  })
  it('retrieves a matching topic through a place alias', () => {
    const aliased = {
      ...directory,
      places: [{ ...directory.places[0]!, longDescription: 'Also called: Sky Flash' }],
    }
    const result = addExplicitGuestGuideRecords({
      directory: aliased,
      question: 'Sky Flash?',
      places: [],
      knowledgeEntries: [],
    })
    expect(result.knowledgeEntries[0]?.id).toBe('ride-facts')
  })
  it('restores a retrieved full topic even when not explicitly named', () => {
    const result = addExplicitGuestGuideRecords({
      directory,
      question: 'What can I do?',
      places: [],
      knowledgeEntries: [{ ...directory.knowledge[0]!, content: 'excerpt', distance: 0.1 }],
    })
    expect(result.knowledgeEntries[0]?.content).toBe(directory.knowledge[0]!.content)
  })
  it('preserves a newer retrieved edit', () => {
    const entry = {
      ...directory.knowledge[0]!,
      content: 'New operator edit',
      updatedAt: new Date('2026-10-13'),
      distance: 0.2,
    }
    expect(
      addExplicitGuestGuideRecords({
        directory,
        question: 'Lightning',
        places: [],
        knowledgeEntries: [entry],
      }).knowledgeEntries[0]?.content,
    ).toBe('New operator edit')
  })
  it('compares tiered records for stale facts without changing detail IDs', () => {
    const guide = buildGuestGuideStrategy(directory, { currentDate: '2026-10-13', tiered: true })
    const stale = staleGuestGuideRecordIds({ guide, directory, places: [], knowledgeEntries: [{ id: 'ride-facts', updatedAt: new Date('2026-10-13') }] })
    expect([...stale]).toEqual(['knowledge:ride-facts'])
    expect(guide.recordIds.size).toBe(0)
    expect(staleGuestGuideRecordIds({ guide: { ...guide, mode: 'DIRECTORY' }, directory, places: [], knowledgeEntries: [{ id: 'ride-facts', updatedAt: new Date('2026-10-13') }] }).size).toBe(0)
  })
  it('preserves different unversioned content and marks it unsafe for computed facts', () => {
    const entry = { ...directory.knowledge[0]!, updatedAt: undefined, content: 'Different live facts', distance: 0.1 }
    const { updatedAt: ignored, ...unversioned } = entry
    void ignored
    const records = addExplicitGuestGuideRecords({ directory, question: 'Thunderbolt', places: [], knowledgeEntries: [unversioned] })
    expect(records.knowledgeEntries[0]?.content).toBe('Different live facts')
    const guide = buildGuestGuideStrategy(directory, { currentDate: '2026-10-13', tiered: true })
    expect([...staleGuestGuideRecordIds({ guide, directory, places: [], knowledgeEntries: records.knowledgeEntries })]).toEqual(['knowledge:ride-facts'])
  })
  it('restores an unversioned excerpt only with matching provenance', () => {
    const { updatedAt: ignored, ...record } = directory.knowledge[0]!
    void ignored
    const restore = (content: string) => addExplicitGuestGuideRecords({ directory, question: 'Thunderbolt', places: [], knowledgeEntries: [{ ...record, content, distance: 0.1 }] }).knowledgeEntries[0]?.content
    expect(restore('A steel roller coaster.\n...[source excerpt]...')).toBe(record.content)
    expect(restore('Changed facts\n...[source excerpt]...')).toBe('Changed facts\n...[source excerpt]...')
  })

})
