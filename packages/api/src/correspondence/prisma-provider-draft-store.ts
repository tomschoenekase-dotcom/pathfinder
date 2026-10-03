import { db, writeAuditLogStrict } from '@pathfinder/db'

import type { ProviderDraftReferenceStore } from './gmail-drafts'

const SYSTEM_ACTOR_ID = 'system:gmail-draft-reconciliation'

/**
 * Prospect outreach drafts and provider accounts are platform-owned tables, so these reads are
 * scoped by the exact provider account instead of a tenant. Only the reference pair is changed;
 * the local draft status (including SENT) is never written here.
 */
export function createPrismaProviderDraftReferenceStore(): ProviderDraftReferenceStore {
  return {
    async listReferencedDrafts(input) {
      const rows = await db.prospectOutreachDraft.findMany({
        where: { providerDraftAccountId: input.providerAccountId, providerDraftId: { not: null } },
        orderBy: { id: 'asc' },
        take: input.limit,
        select: { id: true, providerDraftId: true },
      })
      return rows.flatMap((row) =>
        row.providerDraftId ? [{ localDraftId: row.id, providerDraftId: row.providerDraftId }] : [],
      )
    },
    async releaseAbsentReference(input) {
      return db.$transaction(async (tx) => {
        const released = await tx.prospectOutreachDraft.updateMany({
          where: {
            id: input.localDraftId,
            providerDraftAccountId: input.providerAccountId,
            providerDraftId: input.providerDraftId,
          },
          data: { providerDraftAccountId: null, providerDraftId: null },
        })
        if (released.count !== 1) return false
        await writeAuditLogStrict(
          {
            actorType: 'SYSTEM',
            actorId: SYSTEM_ACTOR_ID,
            actorRole: 'SYSTEM',
            action: 'prospect_draft.provider_draft_absent',
            targetType: 'ProspectOutreachDraft',
            targetId: input.localDraftId,
            beforeState: {
              providerDraftAccountId: input.providerAccountId,
              providerDraftId: input.providerDraftId,
            },
            afterState: {
              providerDraftAccountId: null,
              providerDraftId: null,
              observedAbsentAt: input.observedAt.toISOString(),
              // Absence is not dispatch evidence; local draft status was left unchanged.
              localStatusChanged: false,
            },
          },
          tx,
        )
        return true
      })
    },
  }
}
