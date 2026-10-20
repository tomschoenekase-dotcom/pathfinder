// External, UNRUN: synthetic authorized corpus and query-only fallback checks.
import { expect, it } from 'vitest'
import { guestQueryConcepts, guestRetrievalConcepts } from './guest-knowledge-retrieval'
import { guestQueryRarity } from './guest-query-rarity'
import type { GuestVenueDirectory } from './guest-venue-directory'
const query = 'spectacular architecture sculpture displays demonstrations workshops collections Ark'
const directory = {
  knowledge: [],
  places: [
    {
      id: 'ark-w7',
      name: 'Ark',
      type: 'PLACE',
      tags: [],
      longDescription: 'A prism collection.',
    },
  ],
  incomplete: false,
} as unknown as GuestVenueDirectory
it('preserves query-only behavior while authorized rarity recovers late Ark', () => {
  expect(guestQueryConcepts(query).flat()).not.toContain('ark')
  expect(guestQueryConcepts(query, guestQueryRarity(directory, query)).flat()).toContain('ark')
})
it('does not promote isolated tokens of an absent multiword name phrase', () => {
  const corpus = {
    ...directory,
    places: [{ ...directory.places[0]!, name: 'Blue Ark' }],
  }
  expect(guestQueryRarity(corpus, 'Ark').exactNameTokens.has('ark')).toBe(false)
  expect(guestQueryRarity(corpus, 'Blue Ark').exactNameTokens.has('ark')).toBe(true)
})

it('keeps current and previous exact-name priorities separate in follow-up borrowing', () => {
  const corpus = {
    ...directory,
    places: [...directory.places, { ...directory.places[0]!, id: 'prism', name: 'Prism' }],
  }
  const current = guestQueryRarity(corpus, 'Which one?')
  const previous = guestQueryRarity(corpus, query)
  expect(current.exactNameTokens.has('ark')).toBe(false)
  expect(previous.exactNameTokens.has('ark')).toBe(true)
  expect(
    guestRetrievalConcepts('Which one?', query, {
      current,
      previous,
    }).concepts.flat(),
  ).toContain('ark')
})
it('uses deterministic original query order for tied corpus frequencies and never treats unknown as rare', () => {
  const hints = {
    documentFrequency: new Map([
      ['ark', 1],
      ['prism', 1],
    ]),
    exactNameTokens: new Set<string>(),
  }
  const first = guestQueryConcepts('ark prism quuxword unknownword', hints)
  expect(first).toEqual(guestQueryConcepts('ark prism quuxword unknownword', hints))
  expect(first.flat().indexOf('ark')).toBeLessThan(first.flat().indexOf('quuxword'))
})

it('follows place addition/removal under the same native authoritative version', () => {
  const searchVersion = 'tenant:venue:PUBLIC:NATIVE:membership-place-test'
  const without = { ...directory, searchVersion, places: [] }
  const withArk = { ...directory, searchVersion }
  expect(guestQueryRarity(without, 'Ark').exactNameTokens.has('ark')).toBe(false)
  const added = guestQueryRarity(withArk, 'Ark')
  expect(added.exactNameTokens.has('ark')).toBe(true)
  expect(added.documentFrequency.get('ark')).toBe(1)
  const removed = guestQueryRarity(without, 'Ark')
  expect(removed.exactNameTokens.has('ark')).toBe(false)
  expect(removed.documentFrequency.has('ark')).toBe(false)
})
it('follows knowledge addition/removal under the same native authoritative version', () => {
  const searchVersion = 'tenant:venue:PUBLIC:NATIVE:membership-knowledge-test'
  const without = { ...directory, places: [], knowledge: [], searchVersion }
  const withArk = {
    ...without,
    knowledge: [
      { id: 'knowledge-ark', title: 'Ark', category: 'GENERAL', content: 'Violet prism.' },
    ],
  } as unknown as GuestVenueDirectory
  expect(guestQueryRarity(without, 'Ark').documentFrequency.has('ark')).toBe(false)
  expect(guestQueryRarity(withArk, 'Ark').documentFrequency.get('ark')).toBe(1)
  expect(guestQueryRarity(without, 'Ark').documentFrequency.has('ark')).toBe(false)
})
it('keeps typed knowledge/place membership independent even for colliding bare IDs', () => {
  const searchVersion = 'tenant:venue:PUBLIC:NATIVE:typed-membership-test'
  const placeOnly = {
    ...directory,
    searchVersion,
    places: [{ ...directory.places[0]!, id: 'same' }],
  }
  const knowledgeOnly = {
    ...directory,
    searchVersion,
    places: [],
    knowledge: [{ id: 'same', title: 'Prism', category: 'GENERAL', content: 'Violet.' }],
  } as unknown as GuestVenueDirectory
  expect(guestQueryRarity(placeOnly, 'Ark').exactNameTokens.has('ark')).toBe(true)
  expect(guestQueryRarity(knowledgeOnly, 'Ark').exactNameTokens.has('ark')).toBe(false)
  expect(guestQueryRarity(knowledgeOnly, 'Prism').documentFrequency.get('prism')).toBe(1)
})
it('does not retain incomplete corpus before completion with the same version and IDs', () => {
  const searchVersion = 'tenant:venue:PUBLIC:NATIVE:incomplete-first-test'
  const provisional = {
    ...directory,
    searchVersion,
    incomplete: true,
    places: [{ ...directory.places[0]!, name: 'Provisional', longDescription: 'Tentative.' }],
  }
  const complete = { ...directory, searchVersion }
  expect(guestQueryRarity(provisional, 'Provisional').exactNameTokens.has('provisional')).toBe(true)
  const final = guestQueryRarity(complete, 'Ark')
  expect(final.exactNameTokens.has('ark')).toBe(true)
  expect(final.documentFrequency.has('provisional')).toBe(false)
  const laterIncomplete = guestQueryRarity(provisional, 'Provisional')
  expect(laterIncomplete.exactNameTokens.has('provisional')).toBe(true)
  expect(laterIncomplete.documentFrequency.has('ark')).toBe(false)
  expect(guestQueryRarity(complete, 'Ark').exactNameTokens.has('ark')).toBe(true)
})
it('never retains an unversioned corpus with stable membership and changed content', () => {
  const first = { ...directory, places: [{ ...directory.places[0]!, name: 'Transient' }] }
  const second = { ...directory, places: [{ ...directory.places[0]!, name: 'Ark' }] }
  expect(guestQueryRarity(first, 'Transient').exactNameTokens.has('transient')).toBe(true)
  expect(guestQueryRarity(second, 'Ark').exactNameTokens.has('ark')).toBe(true)
})
