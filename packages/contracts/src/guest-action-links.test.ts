import { describe, expect, it } from 'vitest'

import {
  activeGuestActions,
  applyGuestActionMarkers,
  composeGuestActionBlocks,
  GuestActionCatalog,
  GuestActionDefinition,
  isApprovedGuestActionUrl,
  projectGuestActionStreamText,
  renderGuestActionPrompt,
  type GuestActionSettings,
} from './guest-action-links'
import { GuestResponseBlock } from './guest-response'

const now = new Date('2026-10-04T18:00:00.000Z')
const catalog = GuestActionCatalog.parse([
  {
    id: 'burger-order',
    label: 'Order ahead',
    url: 'https://order.toasttab.com/online/burger-barn?utm_source=guide&location=12#menu',
    actionType: 'ORDER_AHEAD',
    placeId: 'place-burger',
    provider: 'Toast',
    conditions: 'Mobile ordering 11am-8pm',
  },
  {
    id: 'pizza-order',
    label: 'Order pizza ahead',
    url: 'https://pizza.example.com/order',
    actionType: 'ORDER_AHEAD',
    placeId: 'place-pizza',
  },
  {
    id: 'season-pass',
    label: 'Buy a season pass',
    url: 'https://tickets.example.com/season-pass?promo=FALL26',
    actionType: 'BUY_PASS',
  },
  {
    id: 'zipline',
    label: 'Book the zipline',
    url: 'https://book.example.com/zipline',
    actionType: 'BOOK_EXPERIENCE',
    enabled: false,
  },
])
const active = activeGuestActions(catalog, now)
const BOTH: GuestActionSettings = { inlineLinks: true, buttons: true }
const LINKS: GuestActionSettings = { inlineLinks: true, buttons: false }
const BUTTONS: GuestActionSettings = { inlineLinks: false, buttons: true }
const NEITHER: GuestActionSettings = { inlineLinks: false, buttons: false }

function render(text: string, settings: GuestActionSettings) {
  const applied = applyGuestActionMarkers({ text, actions: active, settings })
  const blocks = composeGuestActionBlocks({
    content: applied.text,
    placements: applied.placements,
    catalog,
    settings,
    now,
  })
  blocks?.forEach((block) => GuestResponseBlock.parse(block))
  return { ...applied, blocks }
}

const linkAnswer =
  'Burger Barn is open until 8pm. You can [[link:burger-order|order ahead]] to skip the line.'
const buttonAnswer = 'Season passes cover every visit through December. [[button:season-pass]]'

describe('guest action catalog', () => {
  it('rejects unsafe destinations and keeps legitimate booking parameters exactly', () => {
    for (const url of [
      'http://tickets.example.com/pass',
      'https://user:pw@tickets.example.com/pass',
      'https://tickets.example.com/pass?access_token=abc',
      'https://tickets.example.com/pass#api_key=abc',
      'https://localhost/pass',
      'https://10.0.0.5/pass',
      'https://intranet/pass',
      'javascript:alert(1)',
      'https://tickets.example.com/pass now',
    ])
      expect(isApprovedGuestActionUrl(url), url).toBe(false)
    expect(catalog[0]!.url).toBe(
      'https://order.toasttab.com/online/burger-barn?utm_source=guide&location=12#menu',
    )
  })

  it('rejects duplicate IDs and malformed IDs', () => {
    const base = { label: 'Order ahead', url: 'https://a.example.com', actionType: 'OTHER' }
    expect(
      GuestActionCatalog.safeParse([
        { ...base, id: 'a' },
        { ...base, id: 'a' },
      ]).success,
    ).toBe(false)
    expect(GuestActionDefinition.safeParse({ ...base, id: 'Bad ID' }).success).toBe(false)
    expect(GuestActionDefinition.safeParse({ ...base, id: 'a--b' }).success).toBe(false)
  })

  it('omits disabled, expired, not-yet-available and malformed stored actions', () => {
    const stored = [
      ...catalog,
      {
        id: 'expired',
        label: 'Old',
        url: 'https://x.example.com',
        actionType: 'OTHER',
        availableUntil: '2026-10-01T00:00:00Z',
      },
      {
        id: 'future',
        label: 'Soon',
        url: 'https://x.example.com',
        actionType: 'OTHER',
        availableFrom: '2026-11-01T00:00:00Z',
      },
      { id: 'unsafe', label: 'Bad', url: 'http://x.example.com', actionType: 'OTHER' },
      'garbage',
    ]
    expect(activeGuestActions(stored, now).map((action) => action.id)).toEqual([
      'burger-order',
      'pizza-order',
      'season-pass',
    ])
    expect(activeGuestActions(null, now)).toEqual([])
  })
})

describe('guest action prompt', () => {
  const placeNames = new Map([
    ['place-burger', 'Burger Barn'],
    ['place-pizza', 'Pizza Pier'],
  ])

  it('is absent when neither style is enabled or nothing is active', () => {
    expect(renderGuestActionPrompt({ actions: active, settings: NEITHER, placeNames })).toBeNull()
    expect(renderGuestActionPrompt({ actions: [], settings: BOTH, placeNames })).toBeNull()
  })

  it('lists only active IDs with their place, and only the permitted formats', () => {
    const links = renderGuestActionPrompt({ actions: active, settings: LINKS, placeNames })!
    expect(links).toContain(
      'id: burger-order; label: "Order ahead"; type: ORDER_AHEAD; for: "Burger Barn"',
    )
    expect(links).toContain('for: "Pizza Pier"')
    expect(links).not.toContain('zipline')
    expect(links).not.toContain('https://')
    expect(links).toContain('[[link:')
    expect(links).not.toContain('[[button:')
    const buttons = renderGuestActionPrompt({ actions: active, settings: BUTTONS, placeNames })!
    expect(buttons).toContain('[[button:')
    expect(buttons).not.toContain('[[link:')
    const both = renderGuestActionPrompt({ actions: active, settings: BOTH, placeNames })!
    expect(both).toContain('main point of the guest message')
  })
})

describe('applying and rendering action markers under the four venue settings', () => {
  it('both enabled: an inline answer keeps an inline link', () => {
    const result = render(linkAnswer, BOTH)
    expect(result.text).toBe('Burger Barn is open until 8pm. You can order ahead to skip the line.')
    expect(result.blocks).toEqual([
      {
        type: 'text',
        text: result.text,
        links: [
          {
            start: result.text.indexOf('order ahead'),
            end: result.text.indexOf('order ahead') + 'order ahead'.length,
            href: catalog[0]!.url,
            analyticsKey: 'guest-action.burger-order',
          },
        ],
      },
    ])
  })

  it('both enabled: a transactional answer gets exactly one button', () => {
    const result = render(buttonAnswer, BOTH)
    expect(result.text).toBe('Season passes cover every visit through December.')
    expect(result.blocks?.[1]).toMatchObject({
      type: 'actions',
      actions: [
        {
          label: 'Buy a season pass',
          type: 'BUY_TICKETS',
          target: { kind: 'URL', url: 'https://tickets.example.com/season-pass?promo=FALL26' },
        },
      ],
    })
    expect((result.blocks?.[0] as { links?: unknown }).links).toBeUndefined()
  })

  it('links only: a requested button becomes an inline link, never a button', () => {
    const result = render(buttonAnswer, LINKS)
    expect(result.text).toBe(
      'Season passes cover every visit through December.\n\nBuy a season pass',
    )
    expect(result.blocks?.some((block) => block.type === 'actions')).toBe(false)
    expect(result.blocks?.[0]).toMatchObject({
      links: [
        {
          start: result.text.indexOf('Buy a season pass'),
          href: expect.stringContaining('season-pass'),
        },
      ],
    })
  })

  it('buttons only: a requested inline link becomes the single button', () => {
    const result = render(linkAnswer, BUTTONS)
    expect(result.text).toBe('Burger Barn is open until 8pm. You can order ahead to skip the line.')
    expect(result.blocks?.[0]).not.toHaveProperty('links')
    expect(result.blocks?.[1]).toMatchObject({
      type: 'actions',
      actions: [{ label: 'Order ahead', target: { url: catalog[0]!.url } }],
    })
  })

  it('neither: markers are removed and no action of any kind is produced', () => {
    for (const answer of [linkAnswer, buttonAnswer]) {
      const result = render(answer, NEITHER)
      expect(result.placements).toEqual([])
      expect(result.blocks).toBeNull()
      expect(result.text).not.toContain('[[')
    }
  })

  it('never shows the same action as both a link and a button', () => {
    const result = render(
      'You can [[link:season-pass|buy a pass online]] today. [[button:season-pass]]',
      BOTH,
    )
    expect(result.placements).toEqual([{ presentation: 'BUTTON', actionId: 'season-pass' }])
    expect(result.text).toBe('You can buy a pass online today.')
    expect(result.blocks?.[0]).not.toHaveProperty('links')
  })

  it('caps buttons at one and links at two', () => {
    const result = render(
      '[[link:burger-order|Burgers]], [[link:pizza-order|pizza]] and [[link:season-pass|passes]]. [[button:burger-order]] [[button:pizza-order]]',
      BOTH,
    )
    expect(result.placements.filter((p) => p.presentation === 'BUTTON')).toHaveLength(1)
    expect(result.placements.filter((p) => p.presentation === 'INLINE')).toHaveLength(2)
  })

  it('resolves the destination of the exact eatery the model named', () => {
    const result = render(
      'Pizza Pier is near the gate. [[link:pizza-order|Order pizza]] there.',
      LINKS,
    )
    expect((result.blocks?.[0] as { links: { href: string }[] }).links[0]!.href).toBe(
      'https://pizza.example.com/order',
    )
  })

  it('an answer without markers (unrelated question) has no actions', () => {
    const result = render('Restrooms are next to the carousel.', BOTH)
    expect(result.placements).toEqual([])
    expect(result.blocks).toBeNull()
  })

  it('invalid, disabled and malformed action IDs degrade to plain text', () => {
    const result = render(
      'Try [[link:made-up|this deal]] or [[link:zipline|the zipline]] or [[link:Bad ID|that]] or [[button:]] now.',
      BOTH,
    )
    expect(result.text).toBe('Try this deal or the zipline or that or now.')
    expect(result.placements).toEqual([])
    expect(result.blocks).toBeNull()
  })

  it('model-written URLs or HTML stay inert text', () => {
    const result = render(
      '<a href="https://evil.example">Order</a> [[link:burger-order|here]]',
      LINKS,
    )
    const block = result.blocks?.[0] as { text: string; links: { href: string }[] }
    expect(block.text).toContain('<a href="https://evil.example">')
    expect(block.links.map((link) => link.href)).toEqual([catalog[0]!.url])
  })
})

describe('saved conversation replay', () => {
  const applied = applyGuestActionMarkers({ text: linkAnswer, actions: active, settings: BOTH })

  it('follows a changed URL to the venue’s current verified destination', () => {
    const changed = catalog.map((action) =>
      action.id === 'burger-order' ? { ...action, url: 'https://new.example.com/order' } : action,
    )
    const blocks = composeGuestActionBlocks({
      content: applied.text,
      placements: applied.placements,
      catalog: changed,
      settings: BOTH,
      now,
    })
    expect((blocks?.[0] as { links: { href: string }[] }).links[0]!.href).toBe(
      'https://new.example.com/order',
    )
  })

  it('drops a since-disabled or removed action and keeps the text', () => {
    const disabled = catalog.map((action) => ({ ...action, enabled: false }))
    expect(
      composeGuestActionBlocks({
        content: applied.text,
        placements: applied.placements,
        catalog: disabled,
        settings: BOTH,
        now,
      }),
    ).toBeNull()
    expect(
      composeGuestActionBlocks({
        content: applied.text,
        placements: applied.placements,
        catalog: [],
        settings: BOTH,
        now,
      }),
    ).toBeNull()
  })

  it('enforces settings changed after the turn', () => {
    expect(
      composeGuestActionBlocks({
        content: applied.text,
        placements: applied.placements,
        catalog,
        settings: BUTTONS,
        now,
      }),
    ).toBeNull()
    expect(
      composeGuestActionBlocks({
        content: applied.text,
        placements: applied.placements,
        catalog,
        settings: NEITHER,
        now,
      }),
    ).toBeNull()
  })

  it('ignores placements that do not fit the stored text', () => {
    expect(
      composeGuestActionBlocks({
        content: 'Short.',
        placements: [{ presentation: 'INLINE', actionId: 'burger-order', start: 2, end: 400 }],
        catalog,
        settings: BOTH,
        now,
      }),
    ).toBeNull()
  })

  it('keeps places and citations alongside the action blocks', () => {
    const blocks = composeGuestActionBlocks({
      content: applied.text,
      placements: applied.placements,
      catalog,
      settings: BOTH,
      now,
      places: [
        {
          id: 'place-burger',
          name: 'Burger Barn',
          type: 'DINING',
          photoUrl: null,
          shortDescription: null,
          areaName: null,
          hours: null,
          lat: null,
          lng: null,
        },
      ],
      citations: [{ label: 'Dining guide', detail: 'Place: Burger Barn' }],
    })
    expect(blocks?.map((block) => block.type)).toEqual(['text', 'places', 'citations'])
  })
})

describe('streaming projection', () => {
  it('never exposes marker syntax while it is being written and only grows', () => {
    const full = linkAnswer
    let previous = ''
    for (let length = 1; length <= full.length; length += 1) {
      const projected = projectGuestActionStreamText(full.slice(0, length))
      expect(projected).not.toMatch(/\[\[|\]\]|burger-order/u)
      expect(projected.startsWith(previous)).toBe(true)
      previous = projected
    }
    expect(previous).toBe('Burger Barn is open until 8pm. You can order ahead to skip the line.')
  })

  it('releases ordinary brackets that cannot become a marker', () => {
    expect(projectGuestActionStreamText('Gate [A] opens at 9')).toBe('Gate [A] opens at 9')
    expect(projectGuestActionStreamText('See [[note]] here')).toBe('See [[note]] here')
    expect(projectGuestActionStreamText('Done. [[but')).toBe('Done. ')
  })
})
