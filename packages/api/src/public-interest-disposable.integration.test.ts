import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { db } from '@pathfinder/db'

import { router } from './core'
import type { TRPCContext } from './context'
import { adminPublicInterestRouter } from './routers/admin/public-interest'
import { publicInterestRouter } from './routers/public-interest'

const disposable = process.env.PATHFINDER_PUBLIC_INTEREST_DISPOSABLE === '1' ? it : it.skip

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db,
    headers: new Headers({ 'x-forwarded-for': '203.0.113.44' }),
    session: isPlatformAdmin
      ? {
          userId: 'disposable-founder',
          activeTenantId: null,
          role: null,
          isPlatformAdmin: true,
        }
      : { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
  }
}

describe('public interest disposable database lifecycle', () => {
  disposable('persists, replays, reviews, and database-enforces immutable history', async () => {
    const requestId = randomUUID()
    const publicCaller = router({ interest: publicInterestRouter }).createCaller(
      context(false),
    ).interest
    const request = {
      requestId,
      organizationName: 'Disposable River Museum',
      contactName: 'Avery Guide',
      workEmail: `avery-${requestId}@example.test`,
      website: 'https://example.test',
      cityRegion: 'St. Louis, MO',
      venueType: 'Museum or gallery',
      message: 'Please show us the remote setup workflow.',
    }

    await expect(publicCaller.submit(request)).resolves.toEqual({ received: true })
    await expect(publicCaller.submit(request)).resolves.toEqual({ received: true })
    const stored = await db.publicInterestSubmission.findUniqueOrThrow({ where: { requestId } })
    expect(stored.status).toBe('NEW')
    expect(await db.publicInterestSubmission.count({ where: { requestId } })).toBe(1)

    const adminCaller = router({ interest: adminPublicInterestRouter }).createCaller(
      context(true),
    ).interest
    await adminCaller.reviewPublicInterestSubmission({
      operationId: randomUUID(),
      submissionId: stored.id,
      decision: 'MARK_REVIEWED',
      reason: 'Disposable review proof.',
    })
    const reviewed = await db.publicInterestSubmission.findUniqueOrThrow({
      where: { id: stored.id },
    })
    expect(reviewed).toMatchObject({ status: 'REVIEWED', reviewedBy: 'disposable-founder' })

    await expect(
      db.publicInterestSubmission.update({
        where: { id: stored.id },
        data: { organizationName: 'Mutated evidence' },
      }),
    ).rejects.toThrow(/evidence is immutable/u)
    const review = await db.publicInterestSubmissionReview.findFirstOrThrow({
      where: { submissionId: stored.id },
    })
    await expect(
      db.publicInterestSubmissionReview.update({
        where: { id: review.id },
        data: { reason: 'Mutated history' },
      }),
    ).rejects.toThrow(/append-only/u)
  })
})
