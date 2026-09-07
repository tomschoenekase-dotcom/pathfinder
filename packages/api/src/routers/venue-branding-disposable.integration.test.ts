import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => true) }))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn(async () => undefined) }))
vi.mock('@pathfinder/jobs', () => ({
  enqueueEmbedKnowledgeEntry: vi.fn(),
  enqueueEmbedPlace: vi.fn(),
}))

import { db, updateVenueChatDesignAction, withTenantIsolationBypass } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { venueRouter } from './venue'

const enabled =
  process.env.RUN_VENUE_BRANDING_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

const app = router({ venue: venueRouter })

describe.skipIf(!enabled)('governed venue branding on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('enforces scoped immutable receipts and projects only a current approval anonymously', async () =>
    withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `branding-${suffix}`
      const venueId = `venue-branding-${suffix}`
      const otherVenueId = `venue-other-${suffix}`
      const uploadId = `upload-branding-${suffix}`
      const assetId = randomUUID()
      const derivativeId = randomUUID()
      const generation = randomUUID()
      const sha256 = 'a'.repeat(64)
      await db.tenant.create({
        data: { id: tenantId, slug: tenantId, name: 'Disposable branding tenant' },
      })
      await db.venue.createMany({
        data: [
          {
            id: venueId,
            tenantId,
            slug: venueId,
            name: 'Branding venue',
            chatLogoUrl: 'https://legacy.example.test/logo.png',
          },
          { id: otherVenueId, tenantId, slug: otherVenueId, name: 'Other venue' },
        ],
      })
      await db.intakeUpload.create({
        data: {
          id: uploadId,
          tenantId,
          venueId,
          requestId: randomUUID(),
          requestHash: 'b'.repeat(64),
          displayName: 'Logo',
          fileName: 'logo.png',
          mimeType: 'image/png',
          byteSize: 100,
          sha256: 'c'.repeat(64),
          objectKey: `branding/${suffix}/source`,
          objectGeneration: generation,
          requestedBy: 'branding-test',
          requestedByRole: 'PLATFORM_ADMIN',
        },
      })
      await db.venueMediaAsset.create({
        data: {
          id: assetId,
          tenantId,
          venueId,
          intakeUploadId: uploadId,
          kind: 'IMAGE',
          semanticDescription: 'Approved venue logo',
          depictedSubjects: ['logo'],
          altText: 'Venue logo',
          sourceName: 'Disposable fixture',
          createdBy: 'branding-test',
        },
      })
      await db.venueMediaReview.create({
        data: {
          tenantId,
          venueId,
          assetId,
          sequence: 1,
          action: 'APPROVE_CONTENT_USE',
          rightsBasis: 'VENUE_OWNED',
          rightsStatement: 'Disposable venue-owned fixture',
          rightsEvidenceSourceId: 'disposable://branding-proof',
          requestId: randomUUID(),
          actorId: 'branding-test',
        },
      })
      await db.venueMediaDerivative.create({
        data: {
          id: derivativeId,
          tenantId,
          venueId,
          assetId,
          requestId: randomUUID(),
          requestHash: 'd'.repeat(64),
          variant: 'CARD',
          status: 'READY',
          sourceObjectGeneration: generation,
          sourceStorageVersionId: 'source-v1',
          approvedReviewSequence: 1,
          objectKey: `branding/${suffix}/card.webp`,
          storageVersionId: 'derivative-v1',
          mimeType: 'image/webp',
          width: 768,
          height: 384,
          byteSize: 80,
          sha256,
          createdBy: 'branding-test',
          completedAt: new Date(),
        },
      })
      const before = await db.venue.findUniqueOrThrow({ where: { id: venueId } })
      const receipt = {
        assetId,
        derivativeId,
        sourceObjectGeneration: generation,
        sha256,
        approvedReviewSequence: 1,
      }
      await updateVenueChatDesignAction({
        tenantId,
        venueId,
        expectedUpdatedAt: before.updatedAt,
        actor: { type: 'HUMAN', id: 'branding-test', role: 'MANAGER' },
        fields: { chatLogoDerivativeId: derivativeId, chatLogoDerivativeReceipt: receipt },
      })
      const selected = await db.venue.findUniqueOrThrow({ where: { id: venueId } })
      expect(selected).toMatchObject({
        chatLogoUrl: null,
        chatLogoDerivativeId: derivativeId,
        chatLogoDerivativeReceipt: receipt,
      })

      await expect(
        db.$executeRawUnsafe(
          `UPDATE venues SET chat_logo_derivative_receipt = chat_logo_derivative_receipt || '{"extra":true}'::jsonb WHERE id = $1`,
          venueId,
        ),
      ).rejects.toThrow()
      await expect(
        db.$executeRawUnsafe(
          `UPDATE venues SET chat_logo_derivative_id = $1::uuid, chat_logo_derivative_receipt = $2::jsonb WHERE id = $3`,
          derivativeId,
          JSON.stringify(receipt),
          otherVenueId,
        ),
      ).rejects.toThrow()

      const anonymous: TRPCContext = {
        db,
        headers: new Headers(),
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      }
      await expect(
        app.createCaller(anonymous).venue.getBySlug({ slug: venueId }),
      ).resolves.toMatchObject({
        chatLogoUrl: `/api/venue-media/${derivativeId}?venue=${venueId}`,
      })
      await db.venueMediaReview.create({
        data: {
          tenantId,
          venueId,
          assetId,
          sequence: 2,
          action: 'WITHDRAW_CONTENT_USE',
          rightsBasis: null,
          requestId: randomUUID(),
          actorId: 'branding-test',
          reason: 'Revoked for proof',
        },
      })
      await expect(
        app.createCaller(anonymous).venue.getBySlug({ slug: venueId }),
      ).resolves.toMatchObject({ chatLogoUrl: null })

      const current = await db.venue.findUniqueOrThrow({ where: { id: venueId } })
      await updateVenueChatDesignAction({
        tenantId,
        venueId,
        expectedUpdatedAt: current.updatedAt,
        actor: { type: 'HUMAN', id: 'branding-test', role: 'MANAGER' },
        fields: { chatLogoDerivativeId: null, chatLogoDerivativeReceipt: null },
      })
      const cleared = await db.venue.findUniqueOrThrow({ where: { id: venueId } })
      expect(cleared).toMatchObject({
        chatLogoUrl: null,
        chatLogoDerivativeId: null,
        chatLogoDerivativeReceipt: null,
      })
      await expect(
        app.createCaller(anonymous).venue.getBySlug({ slug: venueId }),
      ).resolves.toMatchObject({ chatLogoUrl: null })
    }))
})
