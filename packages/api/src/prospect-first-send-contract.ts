import { z } from 'zod'
const id = z.string().min(1).max(191),
  hash = z.string().regex(/^[a-f0-9]{64}$/u)
const base = { venueId: id, expectedSnapshotHash: hash }
export const firstSendActionShapes = [
  z
    .object({
      action: z.literal('handoffOperational'),
      input: z
        .object({
          ...base,
          draftId: id,
          contentHash: hash,
          meaningReviewId: id,
          providerAccountId: id,
          campaignName: z.string().trim().min(1).max(160),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('reviewOperational'),
      input: z
        .object({
          ...base,
          draftId: id,
          expectedContentHash: hash,
          acknowledgedEscalations: z.array(z.string().max(100)).max(20),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('stageOperational'),
      input: z.object({ ...base, draftId: id, campaignId: id, expectedContentHash: hash }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('approveOperationalBatch'),
      input: z
        .object({
          ...base,
          batchId: id,
          expectedRecipientCount: z.literal(1),
          expectedBatchHash: hash,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('releaseSyntheticBatch'),
      input: z
        .object({
          ...base,
          batchId: id,
          expectedRecipientCount: z.literal(1),
          expectedBatchHash: hash,
          providerAccountId: id,
        })
        .strict(),
    })
    .strict(),
] as const
export type FirstSendAction = z.infer<(typeof firstSendActionShapes)[number]>
export interface NativeOperationalView {
  rehearsal: boolean
  liveSendAvailable: false
  accounts: {
    id: string
    provider: string
    mailbox: string
    connected: boolean
    deliveryEnabled: boolean
  }[]
  candidate: {
    id: string
    campaignId: string
    status: string
    contentHash: string
    recipient: string
    subject: string
    body: string
    generatedBy: string
    generatedByKind: 'HUMAN' | 'AGENT' | 'SYSTEM' | 'INTEGRATION'
    approvedBy: string | null
    sourceDraftId: string
    meaningReviewId: string
    providerAccountId: string
    staleReason: string | null
    escalationFlags: string[]
    synthetic: boolean
    batch: {
      id: string
      status: string
      count: number
      hash: string
      outboxId: string | null
      deliveryState: string
      providerMessageId: string | null
      error: string | null
    } | null
  } | null
  correspondence: {
    id: string
    threadId: string
    direction: string
    providerMessageId: string | null
    subject: string
    preview: string | null
    sourceReference: string | null
  }[]
}
