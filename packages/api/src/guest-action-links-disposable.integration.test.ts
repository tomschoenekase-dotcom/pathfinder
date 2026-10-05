import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import {
  activeGuestActions,
  composeGuestActionBlocks,
  readGuestActionSettings,
  readStoredGuestActions,
} from '@pathfinder/contracts/guest-action-links'
import {
  createVenueAction,
  db,
  updateVenueChatDesignAction,
  VenueActionError,
  withTenantIsolationBypass,
} from '@pathfinder/db'

const enabled =
  process.env.RUN_GUEST_ACTION_LINKS_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

describe.skipIf(!enabled)('disposable guest action links storage', () => {
  afterAll(async () => db.$disconnect())

  it('stores the catalog beside the appearance, keeps it through appearance saves, and refuses foreign places', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `guest-actions-${suffix}`
    const otherTenantId = `guest-actions-other-${suffix}`
    const actor = { type: 'HUMAN' as const, id: 'disposable-manager', role: 'OWNER' as const }
    await withTenantIsolationBypass(async () => {
      for (const id of [tenantId, otherTenantId])
        await db.tenant.create({ data: { id, name: `Disposable ${id}`, slug: id } })
    })
    const { record: venue } = await createVenueAction({
      tenantId,
      actor,
      name: 'Disposable Park',
      baseSlug: `disposable-park-${suffix}`,
      callerSuppliedSlug: true,
      guideMode: 'non_location',
    })
    const { record: otherVenue } = await createVenueAction({
      tenantId: otherTenantId,
      actor,
      name: 'Other Park',
      baseSlug: `other-park-${suffix}`,
      callerSuppliedSlug: true,
      guideMode: 'non_location',
    })
    const [burger, foreign] = await withTenantIsolationBypass(() =>
      Promise.all([
        db.place.create({
          data: { tenantId, venueId: venue.id, name: 'Burger Barn', type: 'DINING' },
          select: { id: true },
        }),
        db.place.create({
          data: {
            tenantId: otherTenantId,
            venueId: otherVenue.id,
            name: 'Elsewhere Cafe',
            type: 'DINING',
          },
          select: { id: true },
        }),
      ]),
    )
    const action = {
      id: 'burger-order',
      label: 'Order ahead',
      url: 'https://order.example.com/burger-barn?location=12&utm_source=guide',
      actionType: 'ORDER_AHEAD' as const,
      placeId: burger.id,
      provider: 'Toast',
      enabled: true,
      conditions: 'Mobile ordering 11am-8pm',
      availableFrom: null,
      availableUntil: null,
    }

    const read = () =>
      db.venue.findFirst({
        where: { id: venue.id, tenantId },
        select: { chatAppearance: true, updatedAt: true },
      })

    // Catalog only, on a venue with no appearance yet.
    let current = (await read())!
    await updateVenueChatDesignAction({
      tenantId,
      venueId: venue.id,
      expectedUpdatedAt: current.updatedAt,
      actor,
      fields: { guestActions: [action] },
    })
    current = (await read())!
    expect(readStoredGuestActions(current.chatAppearance)).toEqual([action])
    expect(readGuestActionSettings(current.chatAppearance)).toEqual({
      inlineLinks: false,
      buttons: false,
    })

    // A dashboard appearance save turns links on and keeps the catalog untouched.
    await updateVenueChatDesignAction({
      tenantId,
      venueId: venue.id,
      expectedUpdatedAt: current.updatedAt,
      actor,
      fields: {
        chatAppearance: {
          version: 1,
          userBubble: true,
          assistantBubble: false,
          userTextColor: null,
          assistantTextColor: null,
          userBubbleColor: null,
          assistantSurfaceColor: null,
          title: 'Disposable Park',
          headerTitleColor: null,
          headerColor: null,
          footerColor: null,
          background: { mode: 'none', focalX: 50, focalY: 50, dim: 45 },
          requestMore: true,
          actionLinks: true,
        },
      },
    })
    current = (await read())!
    expect(readStoredGuestActions(current.chatAppearance)).toEqual([action])
    expect(readGuestActionSettings(current.chatAppearance)).toEqual({
      inlineLinks: true,
      buttons: false,
    })
    const blocks = composeGuestActionBlocks({
      content: 'You can order ahead.',
      placements: [{ presentation: 'INLINE', actionId: 'burger-order', start: 8, end: 19 }],
      catalog: readStoredGuestActions(current.chatAppearance),
      settings: readGuestActionSettings(current.chatAppearance),
      now: new Date(),
    })
    expect(blocks?.[0]).toMatchObject({ links: [{ href: action.url }] })
    expect(
      activeGuestActions(readStoredGuestActions(current.chatAppearance), new Date()),
    ).toHaveLength(1)

    // A place from another tenant is refused and nothing changes.
    await expect(
      updateVenueChatDesignAction({
        tenantId,
        venueId: venue.id,
        expectedUpdatedAt: current.updatedAt,
        actor,
        fields: { guestActions: [{ ...action, placeId: foreign.id }] },
      }),
    ).rejects.toBeInstanceOf(VenueActionError)
    expect(readStoredGuestActions((await read())!.chatAppearance)).toEqual([action])

    // Clearing the catalog leaves the appearance and its switches in place.
    await updateVenueChatDesignAction({
      tenantId,
      venueId: venue.id,
      expectedUpdatedAt: current.updatedAt,
      actor,
      fields: { guestActions: [] },
    })
    current = (await read())!
    expect(readStoredGuestActions(current.chatAppearance)).toEqual([])
    expect(current.chatAppearance).toMatchObject({ title: 'Disposable Park', actionLinks: true })
  })
})
