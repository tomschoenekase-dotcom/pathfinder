import { describe, expect, it, vi } from 'vitest'

import {
  getVenueBotConfigurationAction,
  updateVenueBotConfigurationAction,
} from './venue-bot-configuration-actions'
import { VenueActionError } from './venue-create-action'

const revisionTime = new Date('2026-08-19T12:00:00.000Z')
const actor = { type: 'HUMAN', id: 'manager-1', role: 'MANAGER' } as const
const base = {
  id: 'config-1',
  venueId: 'venue-1',
  presentationMode: 'CLASSIC' as const,
  personalityMode: 'PRESET' as const,
  tonePreset: 'friendly',
  tonePresetVersion: 1,
  responseDepth: 'BALANCED' as const,
  personalityProfileId: null,
  characterKey: null,
  customCharacterId: null,
  publicDisplayName: null,
  greeting: null,
  voiceProfileId: null,
  revision: 1,
  updatedAt: revisionTime,
}

function fixture() {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    venueBotConfiguration: {
      findFirst: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    venue: { updateMany: vi.fn(async () => ({ count: 1 })) },
    personalityProfile: { findFirst: vi.fn() },
    customCharacter: { findFirst: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  }
  const client = { $transaction: vi.fn(async (callback) => callback(tx)) }
  return { tx, client }
}

describe('Venue Bot configuration actions', () => {
  it('returns a Classic default without exposing tenant or actor fields', async () => {
    const venueBotConfiguration = { findFirst: vi.fn(async () => base) }
    await expect(
      getVenueBotConfigurationAction({ tenantId: 'tenant-1', venueId: 'venue-1' }, {
        venueBotConfiguration,
      } as never),
    ).resolves.toEqual({
      ...base,
      updatedAt: revisionTime.toISOString(),
    })
    expect(venueBotConfiguration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1', venueId: 'venue-1' } }),
    )
  })

  it('persists presentation independently while dual-writing all preset compatibility fields', async () => {
    const { tx, client } = fixture()
    tx.venueBotConfiguration.findFirst.mockResolvedValueOnce(base).mockResolvedValueOnce({
      ...base,
      presentationMode: 'CHARACTER',
      tonePreset: 'concise',
      characterKey: 'tochi',
      publicDisplayName: 'Museum guide',
      greeting: 'Hello from the museum',
      revision: 2,
      updatedAt: new Date(revisionTime.getTime() + 1),
    })

    const result = await updateVenueBotConfigurationAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        expectedRevision: 1,
        actor,
        fields: {
          presentationMode: 'CHARACTER',
          tonePreset: 'concise',
          characterKey: 'tochi',
          publicDisplayName: 'Museum guide',
          greeting: 'Hello from the museum',
        },
      },
      client as never,
    )

    expect(result).toMatchObject({
      presentationMode: 'CHARACTER',
      tonePreset: 'concise',
      characterKey: 'tochi',
      revision: 2,
    })
    expect(tx.venueBotConfiguration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', venueId: 'venue-1', revision: 1 },
        data: expect.objectContaining({
          presentationMode: 'CHARACTER',
          tonePreset: 'concise',
          tonePresetVersion: 1,
          revision: { increment: 1 },
          updatedBy: 'manager-1',
        }),
      }),
    )
    expect(tx.venue.updateMany).toHaveBeenCalledWith({
      where: { id: 'venue-1', tenantId: 'tenant-1' },
      data: expect.objectContaining({
        tonePreset: 'concise',
        tonePresetVersion: 1,
        aiTone: 'PROFESSIONAL',
      }),
    })
    const auditJson = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(auditJson).not.toContain('Hello from the museum')
    expect(auditJson).toContain('venue.bot-configuration.updated')
  })

  it('rejects stale revisions before mutation or audit', async () => {
    const { tx, client } = fixture()
    tx.venueBotConfiguration.findFirst.mockResolvedValueOnce({ ...base, revision: 2 })
    await expect(
      updateVenueBotConfigurationAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedRevision: 1,
          actor,
          fields: { presentationMode: 'CLASSIC' },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<VenueActionError>)
    expect(tx.venueBotConfiguration.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('requires custom personality ownership within the same tenant and venue scope', async () => {
    const { tx, client } = fixture()
    tx.venueBotConfiguration.findFirst.mockResolvedValueOnce(base)
    tx.personalityProfile.findFirst.mockResolvedValueOnce({
      id: 'profile-1',
      venueId: 'venue-other',
    })
    await expect(
      updateVenueBotConfigurationAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          expectedRevision: 1,
          actor,
          fields: { personalityMode: 'CUSTOM', personalityProfileId: 'profile-1' },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<VenueActionError>)
    expect(tx.personalityProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'profile-1', tenantId: 'tenant-1', status: 'ACTIVE' },
      }),
    )
    expect(tx.venueBotConfiguration.updateMany).not.toHaveBeenCalled()
  })
})
