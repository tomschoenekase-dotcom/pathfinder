import * as prismaClient from '@prisma/client'
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
    $queryRaw: vi.fn(async () => [{ id: 'credential-1' }]),
    venue: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    venueBotConfiguration: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    venueMediaDerivative: { findMany: vi.fn(async () => []) },
    place: { findFirst: vi.fn(async () => ({ id: 'place-1' })) },
    auditLog: {
      create: vi.fn(async (input: unknown) => {
        void input
        return {}
      }),
      findFirst: vi.fn(),
    },
    externalAccessCredential: {
      findFirst: vi.fn(async () => ({ id: 'credential-1' })),
    },
  }
  return { tx, client: { $transaction: vi.fn(async (callback) => callback(tx)) } }
}

describe('canonical venue actions', () => {
  it('rejects a new raw branding URL through the direct action boundary', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce({
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      chatLogoDerivativeId: null,
      chatBannerDerivativeId: null,
      updatedAt: revision,
    })
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor,
          fields: { chatLogoUrl: 'https://unreviewed.example/logo.png' },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.venue.updateMany).not.toHaveBeenCalled()
  })

  it('rejects every partial derivative ID and receipt update before writing', async () => {
    for (const fields of [
      { chatLogoDerivativeId: '11111111-1111-4111-8111-111111111111' },
      { chatLogoDerivativeReceipt: null },
      { chatLogoDerivativeId: null },
    ]) {
      const { tx, client } = fixture()
      tx.venue.findFirst.mockResolvedValueOnce({
        chatTheme: 'default',
        chatAccentColor: null,
        chatFont: 'jakarta',
        chatLogoUrl: null,
        chatBannerUrl: null,
        chatLogoDerivativeId: null,
        chatBannerDerivativeId: null,
        chatLogoDerivativeReceipt: null,
        chatBannerDerivativeReceipt: null,
        updatedAt: revision,
      })
      await expect(
        updateVenueChatDesignAction(
          { tenantId: 'tenant-1', venueId: 'venue-1', expectedUpdatedAt: revision, actor, fields },
          client as never,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(tx.venue.updateMany).not.toHaveBeenCalled()
    }
  })

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
    expect(tx.venueBotConfiguration.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', venueId: 'venue-1' },
      data: {
        tonePreset: 'concise',
        tonePresetVersion: 1,
        revision: { increment: 1 },
        updatedBy: 'manager-1',
      },
    })
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

  it('accepts a human platform-admin design adapter and replays an exact desired state', async () => {
    const design = {
      chatTheme: 'forest',
      chatAccentColor: '#245A4A',
      chatFont: 'inter',
      chatLogoUrl: 'https://cdn.example.test/reviewed-logo.png',
      chatBannerUrl: null,
      updatedAt: new Date(revision.getTime() + 10),
    }
    const replay = fixture()
    replay.tx.venue.findFirst.mockResolvedValueOnce(design)
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor: { type: 'HUMAN', id: 'platform-1', role: 'PLATFORM_ADMIN' },
          fields: {
            chatTheme: 'forest',
            chatAccentColor: '#245A4A',
            chatFont: 'inter',
            chatLogoUrl: design.chatLogoUrl,
            chatBannerUrl: null,
          },
        },
        replay.client as never,
      ),
    ).resolves.toMatchObject({ replayed: true, updatedAt: design.updatedAt })
    expect(replay.tx.venue.updateMany).not.toHaveBeenCalled()
    expect(replay.tx.auditLog.create).not.toHaveBeenCalled()

    const invalid = fixture()
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor: { type: 'SERVICE' as never, id: 'worker', role: 'PLATFORM_ADMIN' },
          fields: { chatTheme: 'forest' },
        },
        invalid.client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(invalid.tx.venue.findFirst).not.toHaveBeenCalled()
  })

  it('replays a stored appearance regardless of JSON key order and clears it with a database null', async () => {
    const appearance = {
      version: 1 as const,
      userBubble: false,
      assistantBubble: true,
      userTextColor: null,
      assistantTextColor: '#102030',
      userBubbleColor: null,
      assistantSurfaceColor: null,
      title: 'City Zoo',
      headerTitleColor: null,
      headerColor: '#0B1426',
      footerColor: null,
      background: { mode: 'image' as const, focalX: 30, focalY: 70, dim: 40 },
      requestMore: false,
      actionLinks: false,
      actionButtons: false,
    }
    const storedDesign = {
      chatTheme: 'forest',
      chatAccentColor: null,
      chatFont: 'inter',
      chatLogoUrl: null,
      chatBannerUrl: null,
      // PostgreSQL JSONB returns keys in its own order.
      chatAppearance: Object.fromEntries(Object.entries(appearance).reverse()),
      updatedAt: revision,
    }
    const replay = fixture()
    replay.tx.venue.findFirst.mockResolvedValueOnce(storedDesign)
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor,
          fields: { chatAppearance: appearance },
        },
        replay.client as never,
      ),
    ).resolves.toMatchObject({ replayed: true })
    expect(replay.tx.venue.updateMany).not.toHaveBeenCalled()

    const reset = fixture()
    reset.tx.venue.findFirst
      .mockResolvedValueOnce(storedDesign)
      .mockResolvedValueOnce({ ...storedDesign, chatAppearance: null })
    await updateVenueChatDesignAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor,
        fields: { chatAppearance: null },
      },
      reset.client as never,
    )
    const [[update]] = reset.tx.venue.updateMany.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ]
    const data = update.data
    expect(data.chatAppearance).toBe(prismaClient.Prisma.DbNull)
    expect(reset.tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('attributes integration appearance changes to the credential and operation, preserving appearance fields on title update', async () => {
    const existingAppearance = {
      version: 1 as const,
      userBubble: true,
      assistantBubble: false,
      userTextColor: null,
      assistantTextColor: null,
      userBubbleColor: null,
      assistantSurfaceColor: null,
      title: null,
      headerTitleColor: null,
      headerColor: null,
      footerColor: null,
      background: { mode: 'none' as const, focalX: 50, focalY: 50, dim: 45 },
      requestMore: true,
    }
    const fixtureResult = fixture()
    const design = {
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      chatLogoDerivativeId: null,
      chatBannerDerivativeId: null,
      chatLogoDerivativeReceipt: null,
      chatBannerDerivativeReceipt: null,
      chatShowPhotos: true,
      chatShowLinks: true,
      chatAppearance: existingAppearance,
      updatedAt: revision,
    }
    fixtureResult.tx.venue.findFirst.mockResolvedValueOnce(design).mockResolvedValueOnce({
      ...design,
      chatAppearance: { ...existingAppearance, title: 'Space Museum' },
      updatedAt: new Date(revision.getTime() + 1),
    })
    await updateVenueChatDesignAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor: {
          type: 'INTEGRATION',
          credentialId: 'credential-1',
          capability: 'appearance:write',
          scope: 'venue',
          idempotencyKey: '11111111-1111-4111-8111-111111111111',
        },
        fields: { title: 'Space Museum' },
      },
      fixtureResult.client as never,
    )
    const [[update]] = fixtureResult.tx.venue.updateMany.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ]
    expect(update.data.chatAppearance).toMatchObject({
      title: 'Space Museum',
      userBubble: true,
      background: { mode: 'none' },
    })
    expect(fixtureResult.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'INTEGRATION',
          actorId: 'credential-1',
          actorRole: 'INTEGRATION',
          credentialId: 'credential-1',
          capability: 'appearance:write',
          idempotencyKey: '11111111-1111-4111-8111-111111111111',
        }),
      }),
    )
  })

  it('fails closed when the in-transaction credential lock sees a revoked credential', async () => {
    const { tx, client } = fixture()
    tx.$queryRaw.mockResolvedValueOnce([])
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor: {
            type: 'INTEGRATION',
            credentialId: 'credential-1',
            capability: 'appearance:write',
            scope: 'venue',
            idempotencyKey: '66666666-6666-4666-8666-666666666666',
          },
          fields: { chatTheme: 'forest' },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.venue.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('replays an integration appearance operation exactly and rejects changed payload under the same key', async () => {
    const operationId = '55555555-5555-4555-8555-555555555555'
    const integrationActor = {
      type: 'INTEGRATION' as const,
      credentialId: 'credential-1',
      capability: 'appearance:write' as const,
      scope: 'venue' as const,
      idempotencyKey: operationId,
    }
    const stored = {
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      chatLogoDerivativeId: null,
      chatBannerDerivativeId: null,
      chatLogoDerivativeReceipt: null,
      chatBannerDerivativeReceipt: null,
      chatShowPhotos: true,
      chatShowLinks: true,
      chatAppearance: null,
      updatedAt: revision,
    }
    const first = fixture()
    first.tx.venue.findFirst.mockResolvedValueOnce(stored).mockResolvedValueOnce({
      ...stored,
      chatTheme: 'forest',
      updatedAt: new Date(revision.getTime() + 1),
    })
    await updateVenueChatDesignAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor: integrationActor,
        fields: { chatTheme: 'forest' },
      },
      first.client as never,
    )
    const auditCall = first.tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { targetId: string; structuredReason: unknown }
    }

    const retry = fixture()
    retry.tx.auditLog.findFirst.mockResolvedValueOnce({
      targetId: auditCall.data.targetId,
      structuredReason: auditCall.data.structuredReason,
    })
    retry.tx.venue.findFirst.mockResolvedValueOnce({
      ...stored,
      chatTheme: 'forest',
      updatedAt: new Date(revision.getTime() + 1),
    })
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor: integrationActor,
          fields: { chatTheme: 'forest' },
        },
        retry.client as never,
      ),
    ).resolves.toMatchObject({ replayed: true })
    expect(retry.tx.venue.updateMany).not.toHaveBeenCalled()
    expect(retry.tx.auditLog.create).not.toHaveBeenCalled()

    const conflict = fixture()
    conflict.tx.auditLog.findFirst.mockResolvedValueOnce({
      targetId: auditCall.data.targetId,
      structuredReason: auditCall.data.structuredReason,
    })
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor: integrationActor,
          fields: { chatTheme: 'sunset' },
        },
        conflict.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(conflict.tx.venue.updateMany).not.toHaveBeenCalled()
  })

  it('durably binds an integration appearance no-op to its operation ID and payload', async () => {
    const operationId = '88888888-8888-4888-8888-888888888888'
    const integrationActor = {
      type: 'INTEGRATION' as const,
      credentialId: 'credential-1',
      capability: 'appearance:write' as const,
      scope: 'venue' as const,
      idempotencyKey: operationId,
    }
    const stored = {
      chatTheme: 'forest',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      chatLogoDerivativeId: null,
      chatBannerDerivativeId: null,
      chatLogoDerivativeReceipt: null,
      chatBannerDerivativeReceipt: null,
      chatShowPhotos: true,
      chatShowLinks: true,
      chatAppearance: null,
      updatedAt: revision,
    }
    const first = fixture()
    first.tx.venue.findFirst.mockResolvedValueOnce(stored)
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor: integrationActor,
          fields: { chatTheme: 'forest' },
        },
        first.client as never,
      ),
    ).resolves.toMatchObject({ replayed: true })
    expect(first.tx.venue.updateMany).not.toHaveBeenCalled()
    expect(first.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'venue.chat-design.noop',
          credentialId: 'credential-1',
          idempotencyKey: operationId,
          structuredReason: { operationHash: expect.any(String) },
        }),
      }),
    )
    const receipt = first.tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { targetId: string; structuredReason: unknown }
    }

    const retry = fixture()
    retry.tx.auditLog.findFirst.mockResolvedValueOnce({
      targetId: receipt.data.targetId,
      structuredReason: receipt.data.structuredReason,
    })
    retry.tx.venue.findFirst.mockResolvedValueOnce(stored)
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor: integrationActor,
          fields: { chatTheme: 'forest' },
        },
        retry.client as never,
      ),
    ).resolves.toMatchObject({ replayed: true })
    expect(retry.tx.venue.updateMany).not.toHaveBeenCalled()
    expect(retry.tx.auditLog.create).not.toHaveBeenCalled()

    const changed = fixture()
    changed.tx.auditLog.findFirst.mockResolvedValueOnce({
      targetId: receipt.data.targetId,
      structuredReason: receipt.data.structuredReason,
    })
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor: integrationActor,
          fields: { chatTheme: 'sunset' },
        },
        changed.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(changed.tx.venue.updateMany).not.toHaveBeenCalled()
    expect(changed.tx.auditLog.create).not.toHaveBeenCalled()
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

  it('creates and audits a venue under an integration actor with credential lineage', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce(null)
    tx.venue.create.mockResolvedValueOnce({ ...core, places: [], knowledgeEntries: [] })
    const operationId = '22222222-2222-4222-8222-222222222222'
    const result = await createVenueAction(
      {
        tenantId: 'tenant-1',
        actor: {
          type: 'INTEGRATION',
          credentialId: 'credential-1',
          capability: 'venues:create',
          scope: 'client',
          idempotencyKey: operationId,
        },
        name: 'Museum',
        baseSlug: 'museum',
        callerSuppliedSlug: true,
        guideMode: 'non_location',
      },
      client as never,
    )
    expect(result.replayed).toBe(false)
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'INTEGRATION',
          actorId: 'credential-1',
          actorRole: 'INTEGRATION',
          credentialId: 'credential-1',
          capability: 'venues:create',
          idempotencyKey: operationId,
        }),
      }),
    )
  })

  it('does not create a venue when the in-transaction credential lock sees revocation', async () => {
    const { tx, client } = fixture()
    tx.$queryRaw.mockResolvedValueOnce([])
    await expect(
      createVenueAction(
        {
          tenantId: 'tenant-1',
          actor: {
            type: 'INTEGRATION',
            credentialId: 'credential-1',
            capability: 'venues:create',
            scope: 'client',
            idempotencyKey: '77777777-7777-4777-8777-777777777777',
          },
          name: 'Museum',
          baseSlug: 'museum',
          callerSuppliedSlug: true,
          guideMode: 'non_location',
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.venue.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('replays an integration operation by credential and payload and conflicts on key reuse', async () => {
    const operationId = '44444444-4444-4444-8444-444444444444'
    const actor = {
      type: 'INTEGRATION' as const,
      credentialId: 'credential-1',
      capability: 'venues:create' as const,
      scope: 'client' as const,
      idempotencyKey: operationId,
    }
    const first = fixture()
    first.tx.venue.findFirst.mockResolvedValueOnce(null)
    first.tx.venue.create.mockResolvedValueOnce({ ...core, places: [], knowledgeEntries: [] })
    await createVenueAction(
      {
        tenantId: 'tenant-1',
        actor,
        name: 'Museum',
        baseSlug: 'museum',
        callerSuppliedSlug: true,
        guideMode: 'non_location',
      },
      first.client as never,
    )
    const auditCall = first.tx.auditLog.create.mock.calls[0]?.[0] as {
      data: { targetId: string; structuredReason: unknown }
    }

    const retry = fixture()
    retry.tx.auditLog.findFirst.mockResolvedValueOnce({
      targetId: auditCall.data.targetId,
      structuredReason: auditCall.data.structuredReason,
    })
    retry.tx.venue.findFirst.mockResolvedValueOnce({ ...core, places: [], knowledgeEntries: [] })
    await expect(
      createVenueAction(
        {
          tenantId: 'tenant-1',
          actor,
          name: 'Museum',
          baseSlug: 'museum',
          callerSuppliedSlug: true,
          guideMode: 'non_location',
        },
        retry.client as never,
      ),
    ).resolves.toMatchObject({ replayed: true })
    expect(retry.tx.venue.create).not.toHaveBeenCalled()
    expect(retry.tx.auditLog.create).not.toHaveBeenCalled()
    expect(JSON.stringify(retry.tx.$executeRaw.mock.calls)).toContain(`:${operationId}`)

    const conflict = fixture()
    conflict.tx.auditLog.findFirst.mockResolvedValueOnce({
      targetId: auditCall.data.targetId,
      structuredReason: auditCall.data.structuredReason,
    })
    await expect(
      createVenueAction(
        {
          tenantId: 'tenant-1',
          actor,
          name: 'Museum',
          baseSlug: 'museum',
          callerSuppliedSlug: true,
          description: 'Changed setup',
          guideMode: 'non_location',
        },
        conflict.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(conflict.tx.venue.create).not.toHaveBeenCalled()
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
    // The base slug is already a venue's visitor link (in any customer); the suffix keeps 200.
    tx.$queryRaw.mockResolvedValueOnce([{ slug: baseSlug }] as never)
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

describe('guest actions stored beside the chat appearance', () => {
  const action = {
    id: 'burger-order',
    label: 'Order ahead',
    url: 'https://order.example.com/burger-barn?location=12',
    actionType: 'ORDER_AHEAD' as const,
    placeId: 'place-1',
    provider: 'Toast',
    enabled: true,
    conditions: null,
    availableFrom: null,
    availableUntil: null,
  }
  const storedAppearance = {
    version: 1,
    title: 'City Zoo',
    actionLinks: true,
    actionButtons: false,
    guestActions: [action],
  }
  function designRow(chatAppearance: unknown) {
    return {
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      chatAppearance,
      updatedAt: revision,
    }
  }
  function written(tx: ReturnType<typeof fixture>['tx']) {
    const [[update]] = tx.venue.updateMany.mock.calls as unknown as [
      [{ data: { chatAppearance: Record<string, unknown> } }],
    ]
    return update.data.chatAppearance
  }

  it('saves a validated catalog without touching the appearance', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst
      .mockResolvedValueOnce(designRow({ version: 1, title: 'City Zoo' }))
      .mockResolvedValueOnce(designRow(storedAppearance))
    ;(tx.place as Record<string, unknown>).findMany = vi.fn(async () => [{ id: 'place-1' }])
    await updateVenueChatDesignAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor,
        fields: { guestActions: [action] },
      },
      client as never,
    )
    expect(written(tx)).toEqual({ version: 1, title: 'City Zoo', guestActions: [action] })
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('keeps the stored catalog and switches when an older client saves its appearance', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst
      .mockResolvedValueOnce(designRow(storedAppearance))
      .mockResolvedValueOnce(designRow(storedAppearance))
    const olderClientAppearance = {
      version: 1 as const,
      userBubble: true,
      assistantBubble: true,
      userTextColor: null,
      assistantTextColor: null,
      userBubbleColor: null,
      assistantSurfaceColor: null,
      title: 'Zoo',
      headerTitleColor: null,
      headerColor: null,
      footerColor: null,
      background: { mode: 'none' as const, focalX: 50, focalY: 50, dim: 45 },
      requestMore: true,
    }
    await updateVenueChatDesignAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedUpdatedAt: revision,
        actor,
        fields: { chatAppearance: olderClientAppearance },
      },
      client as never,
    )
    expect(written(tx)).toMatchObject({
      title: 'Zoo',
      actionLinks: true,
      actionButtons: false,
      guestActions: [action],
    })
  })

  it('treats an identical catalog as a no-op replay', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce(designRow(storedAppearance))
    ;(tx.place as Record<string, unknown>).findMany = vi.fn(async () => [{ id: 'place-1' }])
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor,
          fields: { guestActions: [action] },
        },
        client as never,
      ),
    ).resolves.toMatchObject({ replayed: true })
    expect(tx.venue.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['an insecure link', { ...action, url: 'http://order.example.com/burger' }],
    ['a link carrying a token', { ...action, url: 'https://order.example.com/b?access_token=x' }],
    ['a malformed ID', { ...action, id: 'Burger Order' }],
  ])('rejects %s', async (_name, invalid) => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce(designRow(null))
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor,
          fields: { guestActions: [invalid] as never },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.venue.updateMany).not.toHaveBeenCalled()
  })

  it('rejects an action tied to a place outside the venue', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce(designRow(null))
    const placeFindMany = vi.fn(async () => [])
    ;(tx.place as Record<string, unknown>).findMany = placeFindMany
    await expect(
      updateVenueChatDesignAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedUpdatedAt: revision,
          actor,
          fields: { guestActions: [{ ...action, placeId: 'other-venue-place' }] },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(placeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: 'venue-1', id: { in: ['other-venue-place'] } },
      }),
    )
  })
})
