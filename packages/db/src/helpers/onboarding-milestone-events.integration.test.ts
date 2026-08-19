import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordOrReplayOnboardingMilestoneEvent } from './onboarding-milestone-events'

const integrationDescribe =
  process.env.RUN_ONBOARDING_MILESTONE_DB_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('onboarding milestone events (disposable PostgreSQL)', () => {
  const suffix = randomUUID().slice(0, 8)
  const tenantId = `milestone-tenant-${suffix}`
  const venueId = `milestone-venue-${suffix}`

  afterAll(async () => {
    await db.$disconnect()
  })

  it('replays exact identity, rejects mutation, and rolls the entire fixture back', async () => {
    await expect(
      withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          await tx.tenant.create({
            data: { id: tenantId, name: 'Milestone fixture', slug: tenantId },
          })
          await tx.venue.create({
            data: { id: venueId, tenantId, name: 'Milestone venue', slug: venueId },
          })
          const input = {
            id: randomUUID(),
            tenantId,
            venueId,
            eventType: 'FIRST_USEFUL_MATERIAL' as const,
            idempotencyKey: 'upload:fixture:verified',
            occurredAt: new Date('2026-08-18T12:00:00.000Z'),
            actorType: 'CLIENT' as const,
            actorId: 'fixture-user',
            sourceType: 'INTAKE_UPLOAD',
            sourceId: 'fixture-upload',
            sourceRevision: 'fixture-receipt',
            category: 'PHOTO',
            durationMs: 100,
          }
          const first = await recordOrReplayOnboardingMilestoneEvent({ db: tx, input })
          const replay = await recordOrReplayOnboardingMilestoneEvent({ db: tx, input })
          expect(first.replayed).toBe(false)
          expect(replay).toMatchObject({ replayed: true, event: { id: first.event.id } })

          await tx.onboardingMilestoneEvent.update({
            where: { id: first.event.id },
            data: { category: 'DOCUMENT' },
          })
        }),
      ),
    ).rejects.toThrow(/append-only/iu)

    await expect(
      withTenantIsolationBypass(() =>
        db.onboardingMilestoneEvent.count({ where: { tenantId, venueId } }),
      ),
    ).resolves.toBe(0)
  })
})
