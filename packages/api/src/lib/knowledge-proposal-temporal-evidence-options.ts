import { z } from 'zod'

import type { TRPCContext } from '../context'
import { mediaIntakeHash } from './media-intake-snapshot'
import {
  mediaTemporalReceiptInput,
  validateMediaTemporalReviewSnapshot,
} from './media-temporal-review-receipt'

const id = z.string().trim().min(1).max(191)
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

export const ListKnowledgeProposalTemporalEvidenceInput = z
  .object({
    tenantId: id,
    venueId: id,
    proposalId: uuid,
    expectedUpdatedAt: z.coerce.date(),
    cursor: z
      .object({
        receiptId: uuid,
        createdAt: timestamp,
        claimOffset: z.number().int().min(0).max(100),
      })
      .strict()
      .optional(),
  })
  .strict()

export type ListKnowledgeProposalTemporalEvidenceInput = z.infer<
  typeof ListKnowledgeProposalTemporalEvidenceInput
>

export class KnowledgeProposalTemporalEvidenceOptionsError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'STALE' | 'INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'KnowledgeProposalTemporalEvidenceOptionsError'
  }
}

export async function listKnowledgeProposalTemporalEvidenceOptions(params: {
  db: TRPCContext['db']
  input: z.input<typeof ListKnowledgeProposalTemporalEvidenceInput>
}) {
  const input = ListKnowledgeProposalTemporalEvidenceInput.parse(params.input)
  const proposal = await params.db.knowledgeChangeProposal.findFirst({
    where: { id: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
    select: { status: true, updatedAt: true, conversationInsightId: true },
  })
  if (!proposal)
    throw new KnowledgeProposalTemporalEvidenceOptionsError(
      'NOT_FOUND',
      'Knowledge proposal not found.',
    )
  if (proposal.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
    throw new KnowledgeProposalTemporalEvidenceOptionsError(
      'STALE',
      'Knowledge proposal changed; reload it.',
    )
  if (!['PENDING_REVIEW', 'APPROVED'].includes(proposal.status))
    throw new KnowledgeProposalTemporalEvidenceOptionsError(
      'INVALID',
      'Knowledge proposal is not reviewable.',
    )

  const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
  const continuing = Boolean(input.cursor && input.cursor.claimOffset > 0)
  const receipt = await params.db.mediaTemporalReviewReceipt.findFirst({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      ...(continuing
        ? { id: input.cursor!.receiptId, createdAt: cursorDate! }
        : input.cursor
          ? {
              OR: [
                { createdAt: { lt: cursorDate! } },
                { createdAt: cursorDate!, id: { lt: input.cursor.receiptId } },
              ],
            }
          : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      snapshot: true,
      snapshotHash: true,
      requestHash: true,
      actorId: true,
      evaluatedAt: true,
      createdAt: true,
    },
  })
  const requiresTemporalEvidence = Boolean(proposal.conversationInsightId)
  if (continuing && !receipt)
    throw new KnowledgeProposalTemporalEvidenceOptionsError(
      'STALE',
      'Temporal evidence cursor is stale.',
    )
  if (!receipt) return { items: [], nextCursor: null, requiresTemporalEvidence }

  const snapshot = validateMediaTemporalReviewSnapshot(receipt.snapshot)
  if (
    receipt.tenantId !== input.tenantId ||
    receipt.venueId !== input.venueId ||
    snapshot.tenantId !== input.tenantId ||
    snapshot.venueId !== input.venueId ||
    snapshot.reviewedBy !== receipt.actorId ||
    snapshot.temporalReview.evaluatedAt !== receipt.evaluatedAt.toISOString() ||
    mediaIntakeHash(snapshot) !== receipt.snapshotHash ||
    mediaIntakeHash({ input: mediaTemporalReceiptInput(snapshot), actorId: receipt.actorId }) !==
      receipt.requestHash
  )
    throw new KnowledgeProposalTemporalEvidenceOptionsError(
      'INVALID',
      'Temporal review receipt failed its scope or integrity check.',
    )

  const now = Date.now()
  const groups = new Map<string, typeof snapshot.temporalReview.claims>()
  for (const claim of snapshot.temporalReview.claims) {
    if (!claim.effectiveFrom || !claim.effectiveUntil) continue
    const target = snapshot.items.find((item) => item.binding.itemHash === claim.targetItemHash)
    if (target?.binding.kind !== 'knowledge') continue
    const value = target.value as {
      title?: unknown
      category?: unknown
      content?: unknown
      isEnabled?: unknown
    }
    if (
      typeof value.title !== 'string' ||
      value.title.length > 60 ||
      typeof value.category !== 'string' ||
      typeof value.content !== 'string' ||
      typeof value.isEnabled !== 'boolean' ||
      claim.value.length > 300
    )
      continue
    const key = mediaIntakeHash([
      receipt.id,
      claim.targetKey,
      claim.targetItemHash,
      claim.value,
      claim.effectiveFrom,
      claim.effectiveUntil,
    ])
    groups.set(key, [...(groups.get(key) ?? []), claim])
  }
  const all = [...groups.entries()].map(([key, claims]) => {
    const chosen = claims.find((claim) => claim.authority === 'AUTHORIZED_STAFF') ?? claims[0]!
    const target = snapshot.items.find((item) => item.binding.itemHash === chosen.targetItemHash)!
    const value = target.value as {
      title: string
      category: string
      content: string
      isEnabled: boolean
    }
    const sourceIds = new Set(claims.map((claim) => claim.source.sourceId))
    return {
      key,
      reference: {
        reviewReceiptId: receipt.id,
        expectedSnapshotHash: receipt.snapshotHash,
        claimId: chosen.claimId,
      },
      desired: {
        title: value.title,
        category: value.category,
        content: chosen.value,
        isEnabled: value.isEnabled,
      },
      validFrom: chosen.effectiveFrom!,
      validUntil: chosen.effectiveUntil!,
      reviewedAt: snapshot.temporalReview.evaluatedAt,
      sourceNames: snapshot.sources
        .filter((source) => sourceIds.has(source.sourceId))
        .slice(0, 100)
        .map((source) => source.filename),
    }
  })
  const offset = continuing ? input.cursor!.claimOffset : 0
  if (offset > all.length)
    throw new KnowledgeProposalTemporalEvidenceOptionsError(
      'STALE',
      'Temporal evidence cursor is stale.',
    )
  const rawPage = all.slice(offset, offset + 20)
  const items = rawPage.filter((item) => Date.parse(item.validUntil) > now)
  const nextOffset = offset + rawPage.length
  return {
    items,
    nextCursor:
      nextOffset < all.length
        ? {
            receiptId: receipt.id,
            createdAt: receipt.createdAt.toISOString(),
            claimOffset: nextOffset,
          }
        : { receiptId: receipt.id, createdAt: receipt.createdAt.toISOString(), claimOffset: 0 },
    requiresTemporalEvidence,
  }
}

export type KnowledgeProposalTemporalEvidenceOptionsResult = Awaited<
  ReturnType<typeof listKnowledgeProposalTemporalEvidenceOptions>
>
