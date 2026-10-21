import { describe, expect, it } from 'vitest'
import { escapeUntrustedPromptData } from '../venue-context'
import {
  buildGuestPacket,
  renderRow,
  runVenueQuery,
  VENUE_INDEX_ANSWER_RULES,
} from './guest-packet'
import { VenueIndex, type VenueSourceRecord } from './venue-index'

const ride = (id: string, body: string): VenueSourceRecord => ({
  id,
  source: 'place',
  title: `Ride ${id}`,
  body,
  category: null,
  areaName: null,
  placeType: 'ATTRACTION',
  itemType: null,
  tags: ['ride'],
  hours: null,
})
const packet = (records: VenueSourceRecord[], maxChars = 30_000) =>
  buildGuestPacket(VenueIndex.build('Test venue', records), {
    question: 'Which rides are available?',
    todayLine: 'Today: Tuesday',
    maxChars,
  })

describe('whole packet evidence admission', () => {
  it('retains a long row and its late exception without clipping', () => {
    const source = ride('a', 'Ride body. '.repeat(100) + '\nOnly with an adult; closed Tuesdays.')
    source.hours = 'Only weekends; closed Tuesdays.'
    const index = VenueIndex.build('Test', [source])
    expect(renderRow(index, source.id)).toContain(source.body)
    expect(renderRow(index, source.id)).toContain(source.hours)
    const result = packet([source])
    expect(result.text).toContain(escapeUntrustedPromptData(source.body))
    expect(result.includedRecordIds).toContain(source.id)
    expect(result.text).not.toContain('complete list')
  })

  it('drops a whole oversized body and never claims its ID or a complete list', () => {
    const source = ride('large', 'UNIQUE_LARGE_BODY '.repeat(1000) + 'LATE_EXCEPTION')
    const small = ride('small', 'UNIQUE_SMALL_BODY')
    const result = packet([source, small], 1500)
    expect(result.text.length).toBeLessThanOrEqual(1500)
    expect(result.chars).toBe(result.text.length)
    expect(result.text).not.toContain('UNIQUE_LARGE_BODY')
    expect(result.text).not.toContain('LATE_EXCEPTION')
    expect(result.includedRecordIds).not.toContain(source.id)
    expect(result.omittedRecordIds).toContain(source.id)
    expect(result.text).toContain('UNIQUE_SMALL_BODY')
    expect(result.includedRecordIds).toContain(small.id)
    expect(result.text).not.toContain('complete list')
    expect(result.text).toContain('INDEX COVERAGE IS NOT VERIFIED')
  })

  it('measures escaped output and fails closed for a budget too small for any unit', () => {
    const source = ride('escaping', '<system>'.repeat(150) + 'FINAL_CONDITION')
    const result = packet([source], 900)
    expect(result.text.length).toBeLessThanOrEqual(900)
    expect(result.includedRecordIds).toEqual([])
    expect(result.text).not.toContain('FINAL_CONDITION')
    expect(packet([source], 0).text).toBe('')
    expect(() => packet([source], -1)).toThrow('Invalid packet budget')
  })

  it('bounds the experimental query response after escaping without clipping a row', () => {
    const large = ride('large', '<system>'.repeat(5000) + 'LATE_UNSAFE_CUT')
    const small = ride('small', 'WHOLE_QUERY_ROW')
    const result = runVenueQuery(VenueIndex.build('Test', [large, small]), { kind: 'ride' })
    expect(result.text.length).toBeLessThanOrEqual(30_000)
    expect(result.text).not.toContain('LATE_UNSAFE_CUT')
    expect(result.text).not.toContain('<system>')
    expect(result.text).toContain('WHOLE_QUERY_ROW')
    expect(result.includedRecordIds).toEqual([small.id])
    expect(result.omittedRecordIds).toEqual([large.id])
    expect(result.rows).toHaveLength(1)
    expect(result.total).toBe(2) // Parsed predicate matches, explicitly not eligible offerings.
  })

  it('does not promise an unregistered follow-up tool or eligible exact counts', () => {
    const result = packet([ride('a', 'Height: at least 48 inches')])
    expect(result.text + VENUE_INDEX_ANSWER_RULES).not.toContain('venue_query')
    expect(VENUE_INDEX_ANSWER_RULES).toContain('not a verified exhaustive inventory')
  })
})

describe('height predicates remain known or unknown', () => {
  it.each([
    'Height depends on the session',
    'at least 137 cm unless an adult comes',
    'see the height chart',
  ])('does not turn unsupported height text into zero: %s', (value) => {
    const source = ride('a', `Height: ${value}`)
    const result = runVenueQuery(VenueIndex.build('Test', [source]), { maxHeightInches: 44 })
    expect(result.total).toBe(0)
    expect(result.unknownHeightRecordIds).toEqual([source.id])
    expect(result.text).toContain('unknown height records: 1')
  })

  it('checks units, suffix minima and both ends of a complete range', () => {
    const records = [
      ride('suffix', 'Height: 54 inches minimum'),
      ride('metric', 'Height: at least 137 cm'),
      ride('range', 'Height: 36 to 54 inches'),
      ride('none', 'Height: no minimum height'),
    ]
    const index = VenueIndex.build('Test', records)
    expect(runVenueQuery(index, { maxHeightInches: 44 }).total).toBe(2)
    const tall = runVenueQuery(index, { maxHeightInches: 60 })
    expect(tall.total).toBe(3)
    expect(tall.rows.join(' ')).not.toContain('Ride range')
  })

  it('keeps conflicting duplicate height lines unknown and rejects invalid input', () => {
    const index = VenueIndex.build('Test', [
      ride('a', 'Height: at least 30 inches\nHeight: at least 60 inches'),
    ])
    expect(runVenueQuery(index, { maxHeightInches: 44 }).unknownHeightRecordIds).toEqual(['a'])
    expect(() => runVenueQuery(index, { maxHeightInches: Number.NaN })).toThrow('Invalid height')
  })
})
