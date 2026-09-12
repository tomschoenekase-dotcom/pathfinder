import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  grantSupportRequestParticipantAction,
  revokeSupportRequestParticipantAction,
} from './support-participant-actions'
import { appendSupportMessageAction } from './support-actions'
import { readSupportPortableExport } from './support-portable-export-read'

function isExplicitDisposableDatabase(): boolean {
  if (process.env.RUN_SUPPORT_PORTABLE_EXPORT_DB_INTEGRATION !== '1') return false
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    const database = decodeURIComponent(url.pathname.slice(1))
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      ['127.0.0.1', '::1', 'localhost'].includes(host) &&
      url.port.length > 0 &&
      /^pathfinder_disposable_[a-z0-9_]+$/u.test(database)
    )
  } catch {
    return false
  }
}

const integrationDescribe = isExplicitDisposableDatabase() ? describe : describe.skip

integrationDescribe('support portable export disposable PostgreSQL boundary', () => {
  const suffix = randomUUID().slice(0, 8)
  const tenantId = `support-export-tenant-${suffix}`
  const venueId = `support-export-venue-${suffix}`
  const otherTenantId = `support-export-other-tenant-${suffix}`
  const otherVenueId = `support-export-other-venue-${suffix}`
  const recipientUserId = `support-export-recipient-${suffix}`
  const otherUserId = `support-export-other-user-${suffix}`
  const foreignUserId = `support-export-foreign-user-${suffix}`
  afterAll(async () => {
    await db.$disconnect()
  })

  it('exports one coherent exact-scope snapshot and enforces role and support ACLs', async () => {
    await withTenantIsolationBypass(async () => {
      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Portable export tenant', slug: tenantId },
          { id: otherTenantId, name: 'Other portable export tenant', slug: otherTenantId },
        ],
      })
      await db.user.createMany({
        data: [
          { id: recipientUserId, email: `${recipientUserId}@example.test`, fullName: 'Recipient' },
          { id: otherUserId, email: `${otherUserId}@example.test`, fullName: 'Other member' },
          { id: foreignUserId, email: `${foreignUserId}@example.test`, fullName: 'Foreign member' },
        ],
      })
      await db.tenantMembership.createMany({
        data: [
          { tenantId, userId: recipientUserId, role: 'OWNER', status: 'ACTIVE' },
          { tenantId, userId: otherUserId, role: 'OWNER', status: 'ACTIVE' },
          { tenantId: otherTenantId, userId: foreignUserId, role: 'OWNER', status: 'ACTIVE' },
        ],
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Export venue', slug: venueId, guideNotes: 'Guide text' },
          {
            id: otherVenueId,
            tenantId: otherTenantId,
            name: 'Foreign venue',
            slug: otherVenueId,
          },
        ],
      })
      await db.venueBotConfiguration.create({
        data: {
          tenantId,
          venueId,
          publicDisplayName: 'Portable guide',
          greeting: 'Welcome.',
          createdBy: 'operator',
          updatedBy: 'operator',
        },
      })
      const place = await db.place.create({
        data: {
          tenantId,
          venueId,
          name: 'Actual gallery',
          type: 'gallery',
          longDescription: 'Actual place body',
          tags: [],
          photoUrl: 'https://private.example.test/place.png?token=secret',
        },
      })
      const knowledge = await db.venueKnowledgeEntry.create({
        data: {
          tenantId,
          venueId,
          title: 'Actual answer',
          category: 'VISIT',
          content: 'Actual knowledge body',
        },
      })
      await db.contentVersion.create({
        data: {
          tenantId,
          venueId,
          entityType: 'PLACE',
          entityId: place.id,
          operation: 'CREATE',
          snapshotSchemaVersion: 1,
          afterState: {
            id: place.id,
            tenantId,
            venueId,
            name: place.name,
            type: place.type,
            itemType: null,
            shortDescription: null,
            longDescription: 'Historical place body',
            lat: null,
            lng: null,
            tags: [],
            importanceScore: 0,
            areaName: null,
            hours: null,
            photoUrl: 'https://private.example.test/history.png',
            isActive: true,
          },
        },
      })
      for (const [schemaVersion, payload] of [
        [
          1,
          {
            schemaVersion: 1,
            places: [{ name: 'V1 place', type: 'exhibit', tags: [], importanceScore: 0 }],
            knowledgeEntries: [],
          },
        ],
        [
          2,
          {
            schemaVersion: 2,
            venue: { guideNotes: 'V2 guide' },
            places: [],
            knowledgeEntries: [],
          },
        ],
        [
          3,
          {
            schemaVersion: 3,
            places: { create: [], update: [], delete: [] },
            knowledgeEntries: {
              create: [
                {
                  itemKey: randomUUID(),
                  provenance: { sourceType: 'CLIENT', contentOrigin: 'HUMAN_AUTHORED' },
                  value: {
                    title: 'V3 answer',
                    category: 'VISIT',
                    content: 'V3 body',
                    isEnabled: true,
                  },
                },
              ],
              update: [],
              delete: [],
            },
          },
        ],
      ] as const) {
        await db.venuePackage.create({
          data: {
            tenantId,
            venueId,
            draftKey: randomUUID(),
            schemaVersion,
            payload,
            payloadHash: String(schemaVersion).repeat(64),
            baseDigest: 'b'.repeat(64),
            validationReport: {},
            previewPlan: {},
            createdBy: 'operator',
          },
        })
      }
      await db.venueReportConfiguration.create({
        data: { tenantId, venueId, enabled: true, updatedBy: 'operator' },
      })
      await db.weeklyReport.create({
        data: {
          tenantId,
          venueId,
          weekStart: new Date('2026-09-01T00:00:00.000Z'),
          weekEnd: new Date('2026-09-08T00:00:00.000Z'),
          status: 'PUBLISHED',
          title: 'Published report',
          content: 'Actual published report body',
          publishedAt: new Date('2026-09-08T01:00:00.000Z'),
          createdBy: 'operator',
        },
      })

      const createRequest = async (requesterUserId: string) => {
        const request = await db.supportRequest.create({
          data: {
            tenantId,
            venueId,
            category: 'GENERAL',
            status: 'OPEN',
            subject: `Request by ${requesterUserId}`,
            createdByKind: 'CLIENT',
            createdById: requesterUserId,
            requesterUserId,
            updatedByKind: 'CLIENT',
            updatedById: requesterUserId,
          },
        })
        return request
      }
      const ownRequest = await createRequest(recipientUserId)
      const unrelatedRequest = await createRequest(otherUserId)
      const sharedRequest = await createRequest(otherUserId)
      const revokedRequest = await createRequest(otherUserId)
      const participantActor = {
        actorType: 'HUMAN' as const,
        participantKind: 'CLIENT' as const,
        actorId: otherUserId,
        auditRole: 'OWNER' as const,
      }
      await grantSupportRequestParticipantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        requestId: sharedRequest.id,
        userId: recipientUserId,
        expectedClientVersion: 1,
        actor: participantActor,
      })
      await grantSupportRequestParticipantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        requestId: revokedRequest.id,
        userId: recipientUserId,
        expectedClientVersion: 1,
        actor: participantActor,
      })
      await revokeSupportRequestParticipantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        requestId: revokedRequest.id,
        userId: recipientUserId,
        expectedClientVersion: 2,
        actor: participantActor,
      })
      const appendClientMessage = async (requestId: string, actorId: string, body: string) => {
        const current = await db.supportRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { clientVersion: true },
        })
        await appendSupportMessageAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          requestId,
          expectedClientVersion: current.clientVersion,
          visibility: 'CLIENT_VISIBLE',
          body,
          attachments: [],
          actor: {
            actorType: 'HUMAN',
            participantKind: 'CLIENT',
            actorId,
            auditRole: 'OWNER',
          },
        })
      }
      await appendClientMessage(ownRequest.id, recipientUserId, 'Visible own message')
      const ownAfterClientMessage = await db.supportRequest.findUniqueOrThrow({
        where: { id: ownRequest.id },
        select: { version: true },
      })
      await appendSupportMessageAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        requestId: ownRequest.id,
        expectedVersion: ownAfterClientMessage.version,
        visibility: 'INTERNAL_ONLY',
        body: 'Internal message must stay private',
        attachments: [],
        actor: {
          actorType: 'HUMAN',
          participantKind: 'OPERATOR',
          actorId: 'operator',
          auditRole: 'PLATFORM_ADMIN',
        },
      })
      await appendClientMessage(
        unrelatedRequest.id,
        otherUserId,
        'Unrelated message must stay private',
      )
      await appendClientMessage(sharedRequest.id, otherUserId, 'Shared visible message')

      const mutationSnapshot = () =>
        Promise.all([
          db.venue.findUniqueOrThrow({ where: { id: venueId }, select: { updatedAt: true } }),
          db.place.findUniqueOrThrow({ where: { id: place.id }, select: { updatedAt: true } }),
          db.venueKnowledgeEntry.findUniqueOrThrow({
            where: { id: knowledge.id },
            select: { updatedAt: true },
          }),
          db.venuePackage.findMany({
            where: { tenantId, venueId },
            orderBy: { id: 'asc' },
            select: { id: true, status: true, updatedAt: true },
          }),
          db.supportRequest.findMany({
            where: { tenantId, venueId },
            orderBy: { id: 'asc' },
            select: { id: true, version: true, clientVersion: true, updatedAt: true },
          }),
          db.offboardingPlan.count({ where: { tenantId } }),
          db.offboardingExportArtifact.count({ where: { tenantId } }),
        ])
      const beforeRead = await mutationSnapshot()

      const result = await readSupportPortableExport({
        tenantId,
        venueId,
        recipientUserId,
        sections: [
          'current-venue',
          'content-history',
          'venue-packages',
          'published-reports',
          'recipient-support',
        ],
      })
      expect(await mutationSnapshot()).toEqual(beforeRead)
      expect(result.currentVenue?.places[0]?.longDescription).toBe('Actual place body')
      expect(result.currentVenue?.knowledgeEntries[0]?.content).toBe('Actual knowledge body')
      expect(
        result.contentHistory?.some(
          (row) =>
            row.entityType === 'PLACE' &&
            JSON.stringify(row.afterState).includes('Historical place body'),
        ),
      ).toBe(true)
      expect(result.venuePackages?.map((row) => row.schemaVersion)).toEqual([1, 2, 3])
      expect(result.publishedReports?.[0]?.content).toBe('Actual published report body')
      expect(result.recipientSupport?.map((request) => request.id).sort()).toEqual(
        [ownRequest.id, sharedRequest.id].sort(),
      )
      expect(JSON.stringify(result)).toContain('Shared visible message')
      expect(JSON.stringify(result)).not.toMatch(
        /Internal message|Unrelated message|private\.example|photoUrl|chatLogoUrl|sourceUrl/,
      )
      expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/u)

      await db.weeklyReport.create({
        data: {
          tenantId,
          venueId,
          weekStart: new Date('2026-09-08T00:00:00.000Z'),
          weekEnd: new Date('2026-09-15T00:00:00.000Z'),
          status: 'PUBLISHED',
          title: 'Oversized but structurally valid report',
          content: 'x'.repeat(10_500_000),
          publishedAt: new Date('2026-09-15T01:00:00.000Z'),
          createdBy: 'operator',
        },
      })
      await expect(
        readSupportPortableExport({
          tenantId,
          venueId,
          recipientUserId,
          sections: ['published-reports'],
        }),
      ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

      await expect(
        readSupportPortableExport({
          tenantId: otherTenantId,
          venueId,
          recipientUserId,
          sections: ['current-venue'],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await db.tenantMembership.update({
        where: { tenantId_userId: { tenantId, userId: recipientUserId } },
        data: { role: 'STAFF' },
      })
      await expect(
        readSupportPortableExport({
          tenantId,
          venueId,
          recipientUserId,
          sections: ['content-history'],
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await db.tenantMembership.update({
        where: { tenantId_userId: { tenantId, userId: recipientUserId } },
        data: { status: 'REMOVED' },
      })
      await expect(
        readSupportPortableExport({
          tenantId,
          venueId,
          recipientUserId,
          sections: ['recipient-support'],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  }, 30_000)
})
