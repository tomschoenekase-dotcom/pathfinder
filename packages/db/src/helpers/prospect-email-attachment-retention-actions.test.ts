import { describe, expect, it, vi } from 'vitest'

import { ProspectActionError } from './prospect-actions'
import {
  prepareProspectEmailAttachmentRetentionAction,
  reviewProspectEmailAttachmentRetentionAction,
} from './prospect-email-attachment-retention-actions'

const actor = { type: 'HUMAN' as const, id: 'founder-1', role: 'PLATFORM_ADMIN' as const }
const operationId = '11111111-1111-4111-8111-111111111111'
const reviewOperationId = '22222222-2222-4222-8222-222222222222'

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    operationId,
    emailMessageId: 'message-1',
    providerAttachmentId: 'attachment-1',
    filename: 'visitor-map.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048n,
    category: 'FLOOR_PLAN_OR_MAP',
    purpose: 'Potential source material for the visitor guide.',
    sourceReference: 'https://mail.google.com/mail/u/team%40torchiko.com/#all/message-1',
    status: 'AWAITING_REVIEW',
    requestedById: 'founder-1',
    reviewOperationId: null,
    reviewedById: null,
    reviewReason: null,
    reviewedAt: null,
    createdAt: new Date('2026-08-23T09:00:00.000Z'),
    ...overrides,
  }
}

function harness() {
  const tx = {
    prospectEmailMessage: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'message-1',
        organizationId: 'organization-1',
        providerAccountId: 'provider-1',
        sourceReference: 'https://mail.google.com/mail/u/team%40torchiko.com/#all/message-1',
        attachmentMetadata: [
          {
            providerAttachmentId: 'attachment-1',
            filename: 'visitor-map.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 2048,
            downloadPolicy: 'METADATA_ONLY',
          },
        ],
      }),
    },
    prospectEmailAttachmentRetentionRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue(
        request({
          status: 'APPROVED_FOR_IMPORT',
          reviewOperationId,
          reviewedById: 'founder-1',
          reviewReason: 'Needed for the visitor map.',
          reviewedAt: new Date('2026-08-23T09:05:00.000Z'),
        }),
      ),
      create: vi.fn().mockResolvedValue(request()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  }
  return {
    tx,
    client: { $transaction: vi.fn((work) => work(tx)) },
  }
}

describe('prepareProspectEmailAttachmentRetentionAction', () => {
  it('snapshots exact metadata into a provider-dark review request and audit', async () => {
    const h = harness()
    const result = await prepareProspectEmailAttachmentRetentionAction(
      {
        operationId,
        emailMessageId: 'message-1',
        providerAttachmentId: 'attachment-1',
        category: 'FLOOR_PLAN_OR_MAP',
        purpose: ' Potential source material for the visitor guide. ',
        actor,
      },
      h.client as never,
    )

    expect(result).toEqual({ request: request(), replayed: false })
    expect(h.tx.prospectEmailAttachmentRetentionRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        emailMessageId: 'message-1',
        providerAttachmentId: 'attachment-1',
        filename: 'visitor-map.pdf',
        sizeBytes: 2048n,
        purpose: 'Potential source material for the visitor guide.',
      }),
      select: expect.any(Object),
    })
    expect(h.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'prospect-email.attachment-retention-requested',
        afterState: expect.objectContaining({
          providerCallExecuted: false,
          bytesDownloaded: false,
          assetImported: false,
        }),
      }),
    })
  })

  it('rejects an attachment ID that is not present in exact metadata-only evidence', async () => {
    const h = harness()
    await expect(
      prepareProspectEmailAttachmentRetentionAction(
        {
          operationId,
          emailMessageId: 'message-1',
          providerAttachmentId: 'missing',
          category: 'CUSTOMER_KNOWLEDGE',
          purpose: 'Needed for venue knowledge.',
          actor,
        },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<ProspectActionError>)
    expect(h.tx.prospectEmailAttachmentRetentionRequest.create).not.toHaveBeenCalled()
  })

  it('replays only an identical operation identity', async () => {
    const h = harness()
    h.tx.prospectEmailAttachmentRetentionRequest.findUnique.mockResolvedValueOnce(request())
    await expect(
      prepareProspectEmailAttachmentRetentionAction(
        {
          operationId,
          emailMessageId: 'message-1',
          providerAttachmentId: 'attachment-1',
          category: 'FLOOR_PLAN_OR_MAP',
          purpose: 'Potential source material for the visitor guide.',
          actor,
        },
        h.client as never,
      ),
    ).resolves.toMatchObject({ replayed: true })
    expect(h.tx.prospectEmailMessage.findUnique).not.toHaveBeenCalled()
  })
})

describe('reviewProspectEmailAttachmentRetentionAction', () => {
  it('records approval without calling a provider, downloading bytes, or importing an asset', async () => {
    const h = harness()
    h.tx.prospectEmailAttachmentRetentionRequest.findUnique.mockResolvedValueOnce(request())
    const result = await reviewProspectEmailAttachmentRetentionAction(
      {
        requestId: request().id,
        reviewOperationId,
        decision: 'APPROVE_FOR_IMPORT',
        reason: 'Needed for the visitor map.',
        actor,
      },
      h.client as never,
    )

    expect(result).toMatchObject({ replayed: false, request: { status: 'APPROVED_FOR_IMPORT' } })
    expect(h.tx.prospectEmailAttachmentRetentionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: request().id, status: 'AWAITING_REVIEW', reviewOperationId: null },
      data: expect.objectContaining({
        status: 'APPROVED_FOR_IMPORT',
        reviewOperationId,
        reviewedById: 'founder-1',
      }),
    })
    expect(h.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'prospect-email.attachment-retention-reviewed',
        afterState: expect.objectContaining({
          providerCallExecuted: false,
          bytesDownloaded: false,
          assetImported: false,
          importRequiresSeparateExecution: true,
        }),
      }),
    })
  })

  it('never overwrites a prior decision with a different review operation', async () => {
    const h = harness()
    h.tx.prospectEmailAttachmentRetentionRequest.findUnique.mockResolvedValueOnce(
      request({
        status: 'DECLINED_SOURCE_ONLY',
        reviewOperationId: '44444444-4444-4444-8444-444444444444',
        reviewedById: 'founder-1',
        reviewReason: 'Gmail remains sufficient.',
      }),
    )
    await expect(
      reviewProspectEmailAttachmentRetentionAction(
        {
          requestId: request().id,
          reviewOperationId,
          decision: 'APPROVE_FOR_IMPORT',
          reason: 'Changed mind.',
          actor,
        },
        h.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<ProspectActionError>)
    expect(h.tx.prospectEmailAttachmentRetentionRequest.updateMany).not.toHaveBeenCalled()
  })
})
