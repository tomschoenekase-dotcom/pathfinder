import { TRPCError } from '@trpc/server'
import { venueLaunchAssetDescriptor } from '@pathfinder/contracts/venue-launch-asset'
import { launchAttachmentsFromSnapshot } from '@pathfinder/contracts/venue-launch-asset-node'
import { db } from '@pathfinder/db'

import { resolveVerifiedCurrentPrintAssets } from '../../prospect-launch-assets'

export async function frozenPdfProofs(
  snapshots: readonly Readonly<{ prospectVenueId: string | null; snapshot: unknown }>[],
) {
  try {
    const proofs = []
    for (const item of snapshots) {
      const attachments = launchAttachmentsFromSnapshot(item.snapshot)
      if (
        !attachments.some(
          (asset) => asset.schema === 'torchiko.venue-launch-asset/2' && asset.format === 'PDF',
        )
      )
        continue
      if (!item.prospectVenueId)
        throw new Error('PDF attachment is not bound to an active prospect venue')
      proofs.push(...(await resolveVerifiedCurrentPrintAssets(item.prospectVenueId, item.snapshot)))
    }
    return proofs
  } catch {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Frozen PDF is stale or could not be verified against the current venue',
    })
  }
}

export async function currentBatchPdfProofs(batchId: string) {
  const batch = await db.prospectSendBatch.findUnique({
    where: { id: batchId },
    select: {
      items: { select: { draft: { select: { venueId: true, groundingSnapshot: true } } } },
    },
  })
  return frozenPdfProofs(
    (batch?.items ?? []).map(({ draft }) => ({
      prospectVenueId: draft.venueId,
      snapshot: draft.groundingSnapshot,
    })),
  )
}

export async function currentDraftPdfProofs(draftIds: readonly string[]) {
  const drafts = await db.prospectOutreachDraft.findMany({
    where: { id: { in: [...new Set(draftIds)] } },
    select: { venueId: true, groundingSnapshot: true },
  })
  return frozenPdfProofs(
    drafts.map((draft) => ({
      prospectVenueId: draft.venueId,
      snapshot: draft.groundingSnapshot,
    })),
  )
}

export function descriptorOnlyDraft<T extends { groundingSnapshot: unknown }>(draft: T): T {
  const attachments = launchAttachmentsFromSnapshot(draft.groundingSnapshot)
  if (!attachments.length) return draft
  const snapshot =
    draft.groundingSnapshot &&
    typeof draft.groundingSnapshot === 'object' &&
    !Array.isArray(draft.groundingSnapshot)
      ? (draft.groundingSnapshot as Record<string, unknown>)
      : {}
  return {
    ...draft,
    groundingSnapshot: {
      ...snapshot,
      launchAttachments: attachments.map(venueLaunchAssetDescriptor),
    },
  }
}
