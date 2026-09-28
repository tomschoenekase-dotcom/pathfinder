import { describe, expect, it } from 'vitest'

import {
  orderKnowledgeAroundAnchor,
  orderPlacesAroundAnchor,
  rankAreaPlaces,
  resolveAreaAnchor,
} from './area-place-ranking'

// Synthetic area guide: invented places around an arbitrary origin. Offsets are
// meters east (x) and north (y) of the origin.
const ORIGIN = { lat: 44, lng: -100 }
const METERS_PER_DEGREE_LAT = 111_320

function at(x: number, y: number) {
  return {
    lat: ORIGIN.lat + y / METERS_PER_DEGREE_LAT,
    lng: ORIGIN.lng + x / (METERS_PER_DEGREE_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  }
}

type FixturePlace = {
  id: string
  name: string
  areaName: string | null
  lat: number | null
  lng: number | null
  tags: string[]
  importanceScore: number
}

function place(
  id: string,
  name: string,
  offset: [number, number] | null,
  tags: string[] = [],
  extra: Partial<FixturePlace> = {},
): FixturePlace {
  const coordinates = offset ? at(...offset) : { lat: null, lng: null }
  return { id, name, areaName: null, tags, importanceScore: 0, ...coordinates, ...extra }
}

const AREA = {
  skyDeck: place('sky-deck', 'Sky Deck', [0, 0], ['included'], { importanceScore: 80 }),
  skyDeckCafe: place('sky-deck-cafe', 'Sky Deck Cafe', [20, 0], [], { areaName: 'Sky Deck' }),
  skyDeckShop: place('sky-deck-shop', 'Sky Deck Gift Shop', [10, 10], [], { areaName: 'Sky Deck' }),
  artMuseum: place('art-museum', 'Harbor Art Museum', [2000, 0], ['included'], {
    importanceScore: 70,
  }),
  aquarium: place('aquarium', 'River Aquarium', [4000, 1000], ['included'], {
    importanceScore: 70,
  }),
  planetarium: place('planetarium', 'Planetarium Dome', [6000, 0], ['included'], {
    importanceScore: 60,
  }),
  lanternBurger: place('lantern-burger', 'Lantern Burger Co.', [3000, 0], ['partner'], {
    importanceScore: 100,
  }),
  oldMillDiner: place('old-mill-diner', 'Old Mill Diner', [1500, 500], ['partner'], {
    importanceScore: 100,
  }),
  bikeRental: place('bike-rental', 'Lakefront Bike Rental', [1000, 1000], ['partner'], {
    importanceScore: 50,
  }),
  cornerSlice: place('corner-slice', 'Corner Slice Pizza', [2050, 0], ['local-pick']),
  mapleTacos: place('maple-tacos', 'Maple Street Tacos', [5200, 0], ['local-pick']),
  docksideNoodles: place('dockside-noodles', 'Dockside Noodles', [2600, -300], ['local-pick']),
  nightMarket: place('night-market', 'Night Market Hall', [3500, 800], [], {
    importanceScore: 100,
  }),
  historyKiosk: place('history-kiosk', 'History Walk Kiosk', null),
}

/** Semantic candidates as the database returns them: fixed cosine distances per query. */
function candidates(distances: Array<[FixturePlace, number]>) {
  return distances.map(([entry, distance]) => ({ ...entry, distance }))
}

function rankIds(
  pool: ReturnType<typeof candidates>,
  visitor: [number, number],
  limit = 10,
): string[] {
  return rankAreaPlaces(pool, at(...visitor), { limit }).map((entry) => entry.id)
}

describe('area-wide guide evaluations (deterministic)', () => {
  it('"At the sky deck, where is food?" puts the cafe inside the sky deck first', () => {
    const query = "I'm at the Sky Deck, where can I get food?"
    const pool = candidates([
      [AREA.oldMillDiner, 0.3],
      [AREA.lanternBurger, 0.3],
      [AREA.skyDeckCafe, 0.32],
      [AREA.skyDeck, 0.35],
      [AREA.cornerSlice, 0.31],
    ])
    const ranked = rankAreaPlaces(pool, at(5, 5), { limit: 10 })
    const anchor = resolveAreaAnchor({ query, places: ranked })
    expect(anchor?.id).toBe('sky-deck')

    const ordered = orderPlacesAroundAnchor(ranked, anchor!)
    expect(ordered.map((entry) => entry.id).slice(0, 2)).toEqual(['sky-deck', 'sky-deck-cafe'])
  })

  it('offers a local pick 200 m away before partners that are kilometres away', () => {
    const pool = candidates([
      [AREA.lanternBurger, 0.28],
      [AREA.oldMillDiner, 0.28],
      [AREA.mapleTacos, 0.3],
    ])
    expect(rankIds(pool, [5400, 0])[0]).toBe('maple-tacos')
  })

  it('"Bored, near the art museum" suggests the nearby included museum first', () => {
    const pool = candidates([
      [AREA.aquarium, 0.3],
      [AREA.planetarium, 0.3],
      [AREA.nightMarket, 0.3],
      [AREA.artMuseum, 0.32],
    ])
    expect(rankIds(pool, [2030, 0])[0]).toBe('art-museum')
  })

  it('prefers a partner over an equally relevant local pick at a comparable distance', () => {
    const partner = place('near-partner', 'Near Partner Grill', [300, 0], ['partner'], {
      importanceScore: 100,
    })
    const localPick = place('near-local', 'Near Local Grill', [-280, 0], ['local-pick'])
    const pool = candidates([
      [localPick, 0.3],
      [partner, 0.3],
    ])
    expect(rankIds(pool, [0, 0])).toEqual(['near-partner', 'near-local'])
  })

  it('never lets a boosted place outrank an as-relevant place under a third of its distance', () => {
    // Without the guard the boost wins: 0.841 x 1.2 > 0.958.
    const boosted = place('boosted', 'Boosted Cafe', [200, 0], ['partner'], {
      importanceScore: 100,
    })
    const nearby = place('nearby', 'Nearby Cafe', [-50, 0])
    const pool = candidates([
      [boosted, 0.3],
      [nearby, 0.3],
    ])
    expect(rankIds(pool, [0, 0])).toEqual(['nearby', 'boosted'])
  })

  it('gives no boost to an untagged place, whatever its importance score', () => {
    // The hall is ~3.59 km away, the plain place 3.45 km. A 1.2x boost would flip
    // them (distance ratio ~1.13), so the order proves the hall got none.
    const pool = candidates([
      [AREA.nightMarket, 0.3],
      [place('plain-hall', 'Plain Hall', [-3450, 0]), 0.3],
    ])
    expect(rankIds(pool, [0, 0])).toEqual(['plain-hall', 'night-market'])

    const tagged = { ...AREA.nightMarket, tags: ['partner'] }
    expect(
      rankIds(
        candidates([
          [tagged, 0.3],
          [place('plain-hall', 'Plain Hall', [-3450, 0]), 0.3],
        ]),
        [0, 0],
      ),
    ).toEqual(['night-market', 'plain-hall'])
  })

  it('keeps a specific answer ahead of weakly related places that happen to be close', () => {
    const pool = candidates([
      [AREA.skyDeckShop, 0.85],
      [AREA.skyDeckCafe, 0.8],
      [AREA.aquarium, 0.2],
    ])
    expect(rankIds(pool, [0, 0])[0]).toBe('aquarium')
  })

  it('lists places without coordinates after located ones, by relevance', () => {
    const pool = candidates([
      [AREA.historyKiosk, 0.1],
      [AREA.artMuseum, 0.3],
    ])
    expect(rankIds(pool, [0, 0])).toEqual(['art-museum', 'history-kiosk'])
  })

  it('respects the retrieval limit', () => {
    const pool = candidates(
      Object.values(AREA).map((entry) => [entry, 0.3] as [FixturePlace, number]),
    )
    expect(rankIds(pool, [0, 0], 4)).toHaveLength(4)
  })

  it('treats places within 150 m of the anchor as part of it, even without an area name', () => {
    const kiosk = place('deck-kiosk', 'Ticket Kiosk', [100, 0])
    const ordered = orderPlacesAroundAnchor([AREA.artMuseum, kiosk, AREA.skyDeck], AREA.skyDeck)
    expect(ordered.map((entry) => entry.id)).toEqual(['sky-deck', 'deck-kiosk', 'art-museum'])
  })

  it('orders knowledge titled for the anchor first', () => {
    const entries = [
      { title: 'Pass rules' },
      { title: 'Sky Deck - tilt ledge tickets' },
      { title: 'sky deck hours' },
    ]
    expect(orderKnowledgeAroundAnchor(entries, AREA.skyDeck).map((entry) => entry.title)).toEqual([
      'Sky Deck - tilt ledge tickets',
      'sky deck hours',
      'Pass rules',
    ])
  })
})

describe('resolveAreaAnchor', () => {
  const places = [AREA.skyDeck, AREA.skyDeckCafe, AREA.artMuseum]

  it('uses the scanned entry place first', () => {
    expect(
      resolveAreaAnchor({ query: 'Harbor Art Museum?', places, entryPlace: AREA.skyDeck })?.id,
    ).toBe('sky-deck')
  })

  it('returns nothing when two places are named or identity is unresolved', () => {
    expect(resolveAreaAnchor({ query: 'Sky Deck or Harbor Art Museum?', places })).toBeNull()
    expect(
      resolveAreaAnchor({ query: 'At the Sky Deck', places, identityUnresolved: true }),
    ).toBeNull()
  })

  it('returns nothing when no supplied place is named', () => {
    expect(resolveAreaAnchor({ query: 'where can I get food?', places })).toBeNull()
  })
})
