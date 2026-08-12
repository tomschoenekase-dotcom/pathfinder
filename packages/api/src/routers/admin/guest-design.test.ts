import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), update: vi.fn() }))

vi.mock('@pathfinder/db', () => ({
  db: { venue: { findFirst: mocks.findFirst } },
  updateVenueChatDesignAction: mocks.update,
  VenueActionError: class VenueActionError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  withTenantIsolationBypass: async <T>(callback: () => Promise<T>) => callback(),
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminGuestDesignRouter } from './guest-design'

const app = router({ admin: adminGuestDesignRouter })
const revision = new Date('2026-08-12T12:00:00.000Z')
const current = {
  id: 'venue-1',
  name: 'Museum',
  description: 'Welcome to the museum.',
  guideMode: 'location_aware',
  aiGuideName: 'Museum Guide',
  chatTheme: 'forest',
  chatAccentColor: '#245A4A',
  chatFont: 'inter',
  chatLogoUrl: 'https://cdn.example.test/reviewed-logo.png',
  chatBannerUrl: null,
  updatedAt: revision,
}

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'platform-1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('admin Guest design adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findFirst.mockResolvedValue(current)
    mocks.update.mockResolvedValue({ ...current, replayed: false })
  })

  it('requires platform-admin authorization before the first database touch', async () => {
    const caller = app.createCaller(context(false))
    await expect(
      caller.admin.getGuestDesign({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.admin.updateGuestDesign({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        fields: { chatTheme: 'forest' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })

  it('reads and mutates only the exact tenant and venue with a human platform actor', async () => {
    const caller = app.createCaller(context(true))
    await expect(
      caller.admin.getGuestDesign({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).resolves.toMatchObject({ id: 'venue-1', chatTheme: 'forest' })
    expect(mocks.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: 'venue-1', tenantId: 'tenant-1' } }),
    )

    await caller.admin.updateGuestDesign({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      expectedUpdatedAt: revision,
      fields: {
        chatTheme: 'dark',
        chatAccentColor: '#ABCDEF',
        chatFont: 'poppins',
        chatLogoUrl: current.chatLogoUrl,
        chatBannerUrl: null,
      },
    })
    expect(mocks.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'venue-1', tenantId: 'tenant-1' },
      select: { chatLogoUrl: true, chatBannerUrl: true },
    })
    expect(mocks.update).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor: { type: 'HUMAN', id: 'platform-1', role: 'PLATFORM_ADMIN' },
        fields: expect.objectContaining({ chatTheme: 'dark', chatFont: 'poppins' }),
      },
      expect.anything(),
    )
  })

  it('fails closed when a caller invents an unreviewed asset reference', async () => {
    await expect(
      app.createCaller(context(true)).admin.updateGuestDesign({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        fields: { chatLogoUrl: 'https://unreviewed.example/new-logo.png' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
