import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { createProspectAction } from './prospect-actions'
import {
  prepareProspectEmailAttachmentRetentionAction,
  reviewProspectEmailAttachmentRetentionAction,
} from './prospect-email-attachment-retention-actions'

const enabled =
  process.env.RUN_PROSPECT_ATTACHMENT_RETENTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('prospect email attachment retention disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('prepares and approves exact Gmail metadata without downloading or importing bytes', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `attachment-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const prospect = await createProspectAction({
        organization: { canonicalName: `Attachment Museum ${suffix}`, source: 'disposable-test' },
        actor,
      })
      const account = await db.correspondenceProviderAccount.create({
        data: {
          provider: 'GMAIL',
          externalAccountId: `attachment-account-${suffix}`,
          mailboxAddress: `attachments-${suffix}@torchiko.example`,
          capabilities: ['RECEIVE'],
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      const thread = await db.prospectEmailThread.create({
        data: {
          organizationId: prospect.organization.id,
          subject: 'Visitor map',
          replyTokenHash: createHash('sha256').update(`attachment-${suffix}`).digest('hex'),
        },
      })
      const message = await db.prospectEmailMessage.create({
        data: {
          threadId: thread.id,
          organizationId: prospect.organization.id,
          direction: 'INBOUND',
          status: 'RECEIVED',
          providerAccountId: account.id,
          providerMessageId: `message-${suffix}`,
          fromAddress: 'curator@example.test',
          toAddresses: [account.mailboxAddress],
          subject: 'Visitor map',
          bodyRetentionState: 'NOT_STORED',
          bodyPreview: 'Attached is the visitor map.',
          sourceReference: `https://mail.google.com/mail/u/${encodeURIComponent(account.mailboxAddress)}/#all/message-${suffix}`,
          attachmentMetadata: [
            {
              providerAttachmentId: `attachment-${suffix}`,
              filename: 'visitor-map.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 4096,
              downloadPolicy: 'METADATA_ONLY',
            },
          ],
          occurredAt: new Date('2026-08-23T09:00:00.000Z'),
        },
      })

      const operationId = randomUUID()
      const prepared = await prepareProspectEmailAttachmentRetentionAction({
        operationId,
        emailMessageId: message.id,
        providerAttachmentId: `attachment-${suffix}`,
        category: 'FLOOR_PLAN_OR_MAP',
        purpose: 'Potential source material for the visitor guide.',
        actor,
      })
      expect(prepared).toMatchObject({
        replayed: false,
        request: {
          filename: 'visitor-map.pdf',
          sizeBytes: 4096n,
          status: 'AWAITING_REVIEW',
        },
      })
      await expect(
        prepareProspectEmailAttachmentRetentionAction({
          operationId,
          emailMessageId: message.id,
          providerAttachmentId: `attachment-${suffix}`,
          category: 'FLOOR_PLAN_OR_MAP',
          purpose: 'Potential source material for the visitor guide.',
          actor,
        }),
      ).resolves.toMatchObject({ replayed: true })

      const reviewOperationId = randomUUID()
      const reviewed = await reviewProspectEmailAttachmentRetentionAction({
        requestId: prepared.request.id,
        reviewOperationId,
        decision: 'APPROVE_FOR_IMPORT',
        reason: 'The map may become part of the venue guide.',
        actor,
      })
      expect(reviewed).toMatchObject({
        replayed: false,
        request: { status: 'APPROVED_FOR_IMPORT', reviewOperationId },
      })
      await expect(
        reviewProspectEmailAttachmentRetentionAction({
          requestId: prepared.request.id,
          reviewOperationId,
          decision: 'APPROVE_FOR_IMPORT',
          reason: 'The map may become part of the venue guide.',
          actor,
        }),
      ).resolves.toMatchObject({ replayed: true })

      expect(
        await db.auditLog.count({
          where: {
            targetId: prepared.request.id,
            action: {
              in: [
                'prospect-email.attachment-retention-requested',
                'prospect-email.attachment-retention-reviewed',
              ],
            },
          },
        }),
      ).toBe(2)
      expect(await db.intakeUpload.count()).toBe(0)
      expect(
        await db.correspondenceProviderAccount.findUniqueOrThrow({
          where: { id: account.id },
          select: { syncCursor: true, lastSuccessfulSyncAt: true },
        }),
      ).toEqual({ syncCursor: null, lastSuccessfulSyncAt: null })
    })
  })
})
