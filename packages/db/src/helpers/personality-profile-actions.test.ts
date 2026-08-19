import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createPersonalityProfileAction,
  listPersonalityProfilesAction,
  updatePersonalityProfileAction,
} from './personality-profile-actions'

const actor = { type: 'HUMAN' as const, role: 'MANAGER' as const, id: 'manager-1' }
const now = new Date('2026-08-19T12:00:00.000Z')
const row = {
  id: 'profile-1',
  venueId: 'venue-1',
  name: 'Warm and concise',
  warmth: 80,
  brevity: 75,
  energy: 40,
  formality: 60,
  customInstruction: 'Use welcoming transitions.',
  revision: 1,
  updatedAt: now,
}
const profile = {
  name: row.name,
  bounds: {
    warmth: 0.8,
    brevity: 0.75,
    energy: 0.4,
    formality: 0.6,
    customInstruction: row.customInstruction,
  },
}

function harness() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    personalityProfile: {
      create: vi.fn().mockResolvedValue(row),
      findFirst: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  }
  return {
    tx,
    client: {
      personalityProfile: { findMany: vi.fn().mockResolvedValue([row]) },
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
    },
  }
}

describe('personality profile actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists only active same-tenant venue or shared profiles and normalizes dimensions', async () => {
    const { client } = harness()
    const result = await listPersonalityProfilesAction(
      { tenantId: 'tenant-1', venueId: 'venue-1' },
      client as never,
    )
    expect(client.personalityProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          status: 'ACTIVE',
          OR: [{ venueId: 'venue-1' }, { venueId: null }],
        },
      }),
    )
    expect(result[0]?.bounds).toEqual(profile.bounds)
  })

  it('creates a venue-scoped profile with bounded storage and content-free audit metadata', async () => {
    const { client, tx } = harness()
    const result = await createPersonalityProfileAction(
      { tenantId: 'tenant-1', venueId: 'venue-1', profile, actor },
      client as never,
    )
    expect(tx.personalityProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          warmth: 80,
          brevity: 75,
          energy: 40,
          formality: 60,
          createdBy: 'manager-1',
        }),
      }),
    )
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).toContain('personality_profile.created')
    expect(audit).not.toContain(row.customInstruction)
    expect(result.id).toBe('profile-1')
  })

  it('updates only the exact active tenant/venue revision and strictly audits', async () => {
    const { client, tx } = harness()
    tx.personalityProfile.findFirst
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, revision: 2 })
    const result = await updatePersonalityProfileAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        profileId: 'profile-1',
        expectedRevision: 1,
        profile,
        actor,
      },
      client as never,
    )
    expect(tx.personalityProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'profile-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          revision: 1,
        }),
        data: expect.objectContaining({ revision: { increment: 1 }, updatedBy: 'manager-1' }),
      }),
    )
    expect(result.revision).toBe(2)
  })

  it('fails closed before writes when the profile is outside exact venue scope', async () => {
    const { client, tx } = harness()
    tx.personalityProfile.findFirst.mockResolvedValue(null)
    await expect(
      updatePersonalityProfileAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          profileId: 'other-profile',
          expectedRevision: 1,
          profile,
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(tx.personalityProfile.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })
})
