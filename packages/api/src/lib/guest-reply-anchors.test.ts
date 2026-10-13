import { describe, expect, it } from 'vitest'

import { guestPlacesNamedInReply } from './guest-reply-anchors'

const place = (id: string, name: string) => ({ id, name })
// A fictional air and space hall: one gallery word ("Orbiter") is shared by many exhibits.
const places = [
  place('tank', 'Orbiter Station Water Tank Fragment'),
  place('suit', "Ada Vance's Pioneer Mk-II Pressure Suit"),
  place('navy-suit', 'Fleet Full-Pressure Suit'),
  place('moon', 'Envoy Lunar Sample'),
  place('cutaway', 'Orbiter Station Cutaway Model'),
  place('patch', 'Orbiter Mission Patch Group'),
  place('timer', 'Orbiter Event Timer'),
  place('robot', "Gizmo, the Hall's Animatronic Robot"),
  place('console-a', 'Mission Console from Ridgeport'),
  place('console-b', 'Mission Console from Ridgeport'),
  place('arch', 'Arch'),
  place('shop', 'Gift Shop'),
]

describe('places named in the previous reply', () => {
  it('finds exhibits a reply names by their everyday names', () => {
    const reply =
      "First-visit highlights include the genuine Moon rock, Ada Vance's Pioneer pressure suit, and the big Orbiter Station water tank fragment that survived reentry."
    expect(guestPlacesNamedInReply(reply, places).map(({ id }) => id)).toEqual(['tank', 'suit'])
  })

  it('does not treat a shared gallery word or a kind word as naming a place', () => {
    expect(
      guestPlacesNamedInReply(
        'The Orbiter gallery is great, and the pressure suits are fun.',
        places,
      ),
    ).toEqual([])
  })

  it('matches a short name only as whole words', () => {
    expect(
      guestPlacesNamedInReply('Walk the archway; the hall is bigger than it looks.', places),
    ).toEqual([])
    expect(
      guestPlacesNamedInReply('Start under the Arch, then the gift shop.', places).map(
        ({ id }) => id,
      ),
    ).toEqual(['arch', 'shop'])
  })

  it('leaves same-name places to identity resolution', () => {
    expect(guestPlacesNamedInReply('Sit at the Mission Console from Ridgeport.', places)).toEqual(
      [],
    )
  })

  it('carries at most three places and nothing for an empty reply', () => {
    const reply =
      "See the Orbiter Station water tank fragment, Ada Vance's Pioneer Mk-II pressure suit, the Orbiter Station cutaway model, the Orbiter event timer and Gizmo the animatronic robot."
    expect(guestPlacesNamedInReply(reply, places)).toHaveLength(3)
    expect(guestPlacesNamedInReply(null, places)).toEqual([])
    expect(guestPlacesNamedInReply('  ', places)).toEqual([])
  })
})
