import { describe, expect, it, vi } from 'vitest'

import {
  deleteVenueAction,
  setVenueAvailabilityAction,
  updateVenueAction,
  updateVenueAiConfigAction,
  updateVenueChatDesignAction,
} from './venue-actions'
import { createVenueAction, VenueActionError } from './venue-create-action'

const revision = new Date('2026-08-11T14:30:00.000Z')
const actor = { type: 'HUMAN', id: 'manager-1', role: 'MANAGER' } as const
const core = {
  id: 'venue-1',
  tenantId: 'tenant-1',
  name: 'Museum',
  slug: 'museum',
  description: 'private body',
  guideNotes: 'private guide notes',
  category: 'museum',
  guideMode: 'location_aware',
  defaultCenterLat: 1,
  defaultCenterLng: 2,
  aiGuideName: null,
  chatTheme: 'default',
  chatAccentColor: null,
  chatFont: 'jakarta',
  chatLogoUrl: 'https://secret.example/logo?token=raw',
  chatBannerUrl: null,
  isActive: true,
  createdAt: revision,
  updatedAt: revision,
  _count: { places: 0 },
}

function fixture() {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    venue: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    place: { findFirst: vi.fn(async () => ({ id: 'place-1' })) },
    auditLog: {
      create: vi.fn(async (input: unknown) => {
        void input
        return {}
      }),
    },
  }
  return { tx, client: { $transaction: vi.fn(async (callback) => callback(tx)) } }
}

describe('canonical venue actions', () => {
  it('changes availability with exact CAS and strict same-transaction audit', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce({
      id: 'venue-1',
      isActive: true,
      updatedAt: revision,
    })
    await expect(
      setVenueAvailabilityAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          enabled: false,
          reason: '  Planned pause  ',
          actor,
        },
        client as never,
      ),
    ).resolves.toMatchObject({ isActive: false, replayed: false })
    expect(tx.venue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'venue-1',
          tenantId: 'tenant-1',
          isActive: true,
          updatedAt: revision,
        },
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'venue.availability.disabled',
        afterState: { enabled: false, reason: 'Planned pause' },
      }),
    })
  })

  it('replays exact availability without a write or duplicate audit', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce({
      id: 'venue-1',
      isActive: false,
      updatedAt: revision,
    })
    await expect(
      setVenueAvailabilityAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          enabled: false,
          reason: 'Still paused',
          actor,
        },
        client as never,
      ),
    ).resolves.toMatchObject({ isActive: false, replayed: true })
    expect(tx.venue.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('updates with exact tenant/revision CAS and audits sanitized state in the transaction', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst
      .mockResolvedValueOnce(core)
      .mockResolvedValueOnce({ ...core, name: 'New', updatedAt: new Date(revision.getTime() + 1) })
    await updateVenueAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor,
        fields: { name: 'New' },
      },
      client as never,
    )
    expect(tx.venue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'venue-1', tenantId: 'tenant-1', updatedAt: revision },
      }),
    )
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).not.toContain('private body')
    expect(audit).not.toContain('secret.example')
  })

  it('fails closed on stale CAS and writes no audit', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce({
      ...core,
      updatedAt: new Date(revision.getTime() + 1),
    })
    await expect(
      updateVenueAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor,
          fields: { name: 'New' },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<VenueActionError>)
    expect(tx.venue.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('fails the mutation transaction when strict audit persistence fails', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst
      .mockResolvedValueOnce(core)
      .mockResolvedValueOnce({ ...core, name: 'New', updatedAt: new Date(revision.getTime() + 1) })
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      updateVenueAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor,
          fields: { name: 'New' },
        },
        client as never,
      ),
    ).rejects.toThrow('audit unavailable')
  })

  it('keeps tone preset and conservative legacy mapping atomic while omitting notes from audit', async () => {
    const { tx, client } = fixture()
    const before = {
      aiGuideNotes: 'secret note',
      aiFeaturedPlaceId: null,
      aiTone: 'FRIENDLY',
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      aiGuideName: null,
      updatedAt: revision,
    }
    const after = {
      ...before,
      aiTone: 'PROFESSIONAL',
      tonePreset: 'concise',
      updatedAt: new Date(revision.getTime() + 1),
    }
    tx.venue.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    await updateVenueAiConfigAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor,
        fields: { tonePreset: 'concise', aiGuideNotes: 'new private note' },
      },
      client as never,
    )
    expect(tx.venue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'venue-1', tenantId: 'tenant-1', updatedAt: revision },
        data: expect.objectContaining({
          tonePreset: 'concise',
          tonePresetVersion: 1,
          aiTone: 'PROFESSIONAL',
        }),
      }),
    )
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('private note')
  })

  it('omits raw design URLs from strict audit and fences deletion by revision', async () => {
    const { tx, client } = fixture()
    const design = {
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: 'https://secret.example/logo',
      chatBannerUrl: null,
      updatedAt: revision,
    }
    tx.venue.findFirst.mockResolvedValueOnce(design).mockResolvedValueOnce({
      ...design,
      chatTheme: 'dark',
      updatedAt: new Date(revision.getTime() + 1),
    })
    await updateVenueChatDesignAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor,
        fields: { chatTheme: 'dark' },
      },
      client as never,
    )
    expect(tx.venue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'venue-1', tenantId: 'tenant-1', updatedAt: revision },
      }),
    )
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('secret.example')

    tx.venue.findFirst.mockReset().mockResolvedValueOnce({
      id: 'venue-1',
      name: 'Museum',
      updatedAt: revision,
      _count: { places: 0 },
    })
    await deleteVenueAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor: { ...actor, role: 'OWNER' },
      },
      client as never,
    )
    expect(tx.venue.deleteMany).toHaveBeenCalledWith({
      where: { id: 'venue-1', tenantId: 'tenant-1', updatedAt: revision },
    })
  })

  it('enforces OWNER at the delete domain boundary before transaction or audit work', async () => {
    const { tx, client } = fixture()
    await expect(
      deleteVenueAction(
        { tenantId: 'tenant-1', venueId: 'venue-1', expectedUpdatedAt: revision, actor },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<VenueActionError>)
    expect(client.$transaction).not.toHaveBeenCalled()
    expect(tx.venue.deleteMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('replays exact caller slugs without a write or duplicate audit', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce({ ...core, places: [], knowledgeEntries: [] })
    const result = await createVenueAction(
      {
        tenantId: 'tenant-1',
        actor: { ...actor, role: 'OWNER' },
        name: 'Museum',
        baseSlug: 'museum',
        callerSuppliedSlug: true,
        description: 'private body',
        guideNotes: 'private guide notes',
        category: 'museum',
        guideMode: 'location_aware',
        defaultCenterLat: 1,
        defaultCenterLng: 2,
      },
      client as never,
    )
    expect(result.replayed).toBe(true)
    expect(tx.venue.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('creates and strictly audits safe venue identity without body or URL data', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce(null)
    tx.venue.create.mockResolvedValueOnce({ ...core, places: [], knowledgeEntries: [] })
    await createVenueAction(
      {
        tenantId: 'tenant-1',
        actor: { ...actor, role: 'OWNER' },
        name: 'Museum',
        baseSlug: 'museum',
        callerSuppliedSlug: false,
        description: 'private body',
        guideNotes: 'private guide notes',
        category: 'museum',
        guideMode: 'location_aware',
        defaultCenterLat: 1,
        defaultCenterLng: 2,
      },
      client as never,
    )
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).not.toContain('private body')
    expect(audit).not.toContain('secret.example')
    expect(JSON.stringify(tx.$executeRaw.mock.calls)).toContain(
      'pathfinder:venue-create:tenant-1:museum',
    )
  })

  it('rejects nonaddressable slugs before a transaction and bounds suffixed auto-slugs', async () => {
    const empty = fixture()
    await expect(
      createVenueAction(
        {
          tenantId: 'tenant-1',
          actor: { ...actor, role: 'OWNER' },
          name: 'Museum',
          baseSlug: '---',
          callerSuppliedSlug: false,
          guideMode: 'non_location',
        },
        empty.client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<VenueActionError>)
    expect(empty.client.$transaction).not.toHaveBeenCalled()

    const { tx, client } = fixture()
    const baseSlug = 'a'.repeat(200)
    tx.venue.findFirst.mockResolvedValueOnce({ id: 'collision' }).mockResolvedValueOnce(null)
    tx.venue.create.mockImplementationOnce(async (args: { data: { slug: string } }) => ({
      ...core,
      slug: args.data.slug,
      places: [],
      knowledgeEntries: [],
    }))
    const created = await createVenueAction(
      {
        tenantId: 'tenant-1',
        actor: { ...actor, role: 'OWNER' },
        name: 'Museum',
        baseSlug,
        callerSuppliedSlug: false,
        guideMode: 'non_location',
      },
      client as never,
    )
    expect(created.record.slug).toHaveLength(200)
    expect(created.record.slug.endsWith('-2')).toBe(true)
    expect(JSON.stringify(tx.$executeRaw.mock.calls)).toContain(
      `pathfinder:venue-create:tenant-1:${baseSlug}`,
    )
  })
})
