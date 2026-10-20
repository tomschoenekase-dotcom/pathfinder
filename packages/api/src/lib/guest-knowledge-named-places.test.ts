import { describe, expect, it } from 'vitest'
import { guestKnowledgeNamedPlaces, type GuestDirectoryPlace } from './guest-venue-directory'

const place = (id: string, name: string): GuestDirectoryPlace => ({
  id,
  name,
  type: 'exhibit',
  itemType: 'exhibit',
  shortDescription: 'Current whole place body.',
  longDescription: null,
  lat: null,
  lng: null,
  tags: [],
  areaName: null,
  hours: null,
  photoUrl: null,
  sourceType: 'FOUNDER_PROVIDED',
  sourceName: 'Test guide',
  sourceUrl: null,
})

const parent = place('parent', 'Harvest Wheel')
const junior = place('junior', 'Harvest Wheel Junior')
const walk = place('walk', 'Reed Walk')
const follow = (content: string, places = [parent, junior, walk]) =>
  guestKnowledgeNamedPlaces({
    knowledge: [{ title: 'Visitor information', content }],
    directory: { knowledge: [], places, incomplete: false },
  }).map((row) => row.id)

describe('bounded named place occurrences', () => {
  it('does not turn a lone nested subject into two named members', () => {
    expect(follow('Harvest Wheel Junior closes on Mondays.')).toEqual([])
  })

  it('keeps the parent when it is mentioned separately from the longer name', () => {
    expect(follow('Visit Harvest Wheel Junior, then Harvest Wheel.')).toEqual(['junior', 'parent'])
    expect(follow('Visit Harvest Wheel, then Harvest Wheel Junior.')).toEqual(['parent', 'junior'])
  })

  it('claims ambiguous longer names without following them or leaking their parent', () => {
    const twins = [parent, junior, place('other-junior', junior.name), walk]
    expect(follow('Visit Harvest Wheel Junior and Reed Walk.', twins)).toEqual([])
    expect(follow('Visit Harvest Wheel Junior, Harvest Wheel and Reed Walk.', twins)).toEqual([
      'parent',
      'walk',
    ])
  })

  it.each(['Reef Halls', 'Reef Hallway'])(
    'does not follow a label that is only a prefix of %s',
    (longer) => {
      expect(follow(`Visit ${longer} and Reed Walk.`, [place('reef', 'Reef Hall'), walk])).toEqual(
        [],
      )
    },
  )

  it('retains an existing four-member collection in mention order', () => {
    const barn = place('barn', 'Story Barn')
    expect(
      follow(
        'The route consists of Harvest Wheel, Harvest Wheel Junior, Reed Walk and Story Barn.',
        [parent, junior, walk, barn],
      ),
    ).toEqual(['parent', 'junior', 'walk', 'barn'])
  })

  it('counts repeated occurrences once and keeps the overview bound', () => {
    expect(follow('Harvest Wheel Junior and Harvest Wheel Junior.')).toEqual([])
    const stalls = Array.from({ length: 9 }, (_, i) => place(`stall-${i}`, `Lantern Stall ${i}`))
    expect(follow(stalls.map((row) => row.name).join(', '), stalls)).toEqual([])
  })
})
