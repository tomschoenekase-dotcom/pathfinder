import { describe, expect, it, vi } from 'vitest'

import {
  onboardingMilestoneIdentityHash,
  OnboardingMilestoneEventError,
  recordOrReplayOnboardingMilestoneEvent,
  type RecordOnboardingMilestoneInput,
} from './onboarding-milestone-events'

const input = (overrides: Partial<RecordOnboardingMilestoneInput> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  eventType: 'FIRST_USEFUL_MATERIAL' as const,
  idempotencyKey: 'upload:upload_1:verified',
  occurredAt: new Date('2026-08-18T12:00:00.000Z'),
  actorType: 'CLIENT' as const,
  actorId: 'user_1',
  sourceType: 'INTAKE_UPLOAD',
  sourceId: 'upload_1',
  sourceRevision: 'receipt_1',
  category: 'PHOTO',
  durationMs: 1200,
  ...overrides,
})

describe('append-only onboarding milestone events', () => {
  it('creates a sanitized immutable identity and exact replay boundary', async () => {
    const db = {
      onboardingMilestoneEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => data),
      },
    }
    const result = await recordOrReplayOnboardingMilestoneEvent({ db, input: input() })
    expect(result.replayed).toBe(false)
    expect(result.event.identityHash).toBe(onboardingMilestoneIdentityHash(input()))
    expect(db.onboardingMilestoneEvent.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ detail: expect.anything(), body: expect.anything() }),
    })
  })

  it('replays only the same exact event identity', async () => {
    const original = input()
    const stored = {
      ...original,
      eventVersion: 1,
      identityHash: onboardingMilestoneIdentityHash(original),
    }
    const db = {
      onboardingMilestoneEvent: {
        findFirst: vi.fn().mockResolvedValue(stored),
        create: vi.fn(),
      },
    }
    await expect(
      recordOrReplayOnboardingMilestoneEvent({ db, input: original }),
    ).resolves.toMatchObject({
      replayed: true,
    })
    await expect(
      recordOrReplayOnboardingMilestoneEvent({
        db,
        input: input({ category: 'DOCUMENT' }),
      }),
    ).rejects.toBeInstanceOf(OnboardingMilestoneEventError)
  })

  it('rejects raw or unbounded source labels before persistence', async () => {
    const db = {
      onboardingMilestoneEvent: { findFirst: vi.fn(), create: vi.fn() },
    }
    await expect(
      recordOrReplayOnboardingMilestoneEvent({
        db,
        input: input({ sourceType: 'raw conversation body' }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(db.onboardingMilestoneEvent.findFirst).not.toHaveBeenCalled()
  })
})
