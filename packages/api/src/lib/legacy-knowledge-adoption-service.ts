import { TRPCError } from '@trpc/server'

import { CreateLegacyKnowledgeAdoptionDraftInput } from '@pathfinder/contracts/legacy-knowledge-adoption'
import { createUniversalContentAction, writeAuditLogStrict } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import {
  legacyKnowledgeAdoptionDraftHash,
  legacyKnowledgeAdoptionModuleId,
  legacyKnowledgeSnapshotHash,
} from './legacy-knowledge-adoption'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

type ScopedDb = TRPCContext['db']
type Receipt = {
  moduleId: string
  revisionId: string
  proposalUpdatedAt: Date
  legacyKnowledgeUpdatedAt: Date
  legacySnapshotHash: string
  draftHash: string
}

const legacySelect = {
  id: true,
  title: true,
  category: true,
  content: true,
  isEnabled: true,
  visibility: true,
  sourceType: true,
  authorship: true,
  sourceName: true,
  sourceUrl: true,
  importedAt: true,
  humanConfirmedAt: true,
  humanConfirmedBy: true,
  lastReviewedAt: true,
  lastReviewedBy: true,
  sourcePackageId: true,
  contentModuleId: true,
  contentRevisionId: true,
  contentPublicationId: true,
  createdAt: true,
  updatedAt: true,
} as const

function snapshot(
  row: Awaited<ReturnType<typeof loadLegacy>> extends infer T ? NonNullable<T> : never,
) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    content: row.content,
    isEnabled: row.isEnabled,
    visibility: row.visibility,
    sourceType: row.sourceType,
    authorship: row.authorship,
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    importedAt: row.importedAt?.toISOString() ?? null,
    humanConfirmedAt: row.humanConfirmedAt?.toISOString() ?? null,
    humanConfirmedBy: row.humanConfirmedBy,
    lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
    lastReviewedBy: row.lastReviewedBy,
    sourcePackageId: row.sourcePackageId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function loadLegacy(db: ScopedDb, scope: { tenantId: string; venueId: string; id: string }) {
  return db.venueKnowledgeEntry.findFirst({ where: scope, select: legacySelect })
}

async function loadReceipt(
  db: ScopedDb,
  scope: { tenantId: string; venueId: string; proposalId: string },
) {
  const rows = await db.$queryRaw<Receipt[]>`
    SELECT module_id AS "moduleId", revision_id AS "revisionId",
           proposal_updated_at AS "proposalUpdatedAt",
           legacy_knowledge_updated_at AS "legacyKnowledgeUpdatedAt",
           legacy_snapshot_hash AS "legacySnapshotHash", draft_hash AS "draftHash"
      FROM legacy_knowledge_universal_content_adoptions
     WHERE tenant_id = ${scope.tenantId} AND venue_id = ${scope.venueId}
       AND proposal_id = ${scope.proposalId}::uuid
     LIMIT 1
  `
  return rows[0] ?? null
}

export async function createLegacyKnowledgeAdoptionDraftService(params: {
  db: ScopedDb
  actor:
    | { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
    | {
        type: 'AGENT'
        id: string
        role: 'AGENT'
        authorization: 'APPROVED_SEMANTIC_PROPOSAL'
      }
  input: unknown
}) {
  const input = CreateLegacyKnowledgeAdoptionDraftInput.parse(params.input)
  const proposalUpdatedAt = new Date(input.expectedProposalUpdatedAt)
  const legacyUpdatedAt = new Date(input.expectedLegacyUpdatedAt)
  const proposal = await params.db.knowledgeChangeProposal.findFirst({
    where: { id: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
    select: { status: true, updatedAt: true, targetKnowledgeEntryId: true },
  })
  if (!proposal)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge proposal not found.' })
  if (
    proposal.status !== 'APPROVED' ||
    proposal.updatedAt.getTime() !== proposalUpdatedAt.getTime() ||
    proposal.targetKnowledgeEntryId !== input.legacyKnowledgeEntryId
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The exact targeted proposal is not approved.',
    })
  }
  const source = await loadLegacy(params.db, {
    tenantId: input.tenantId,
    venueId: input.venueId,
    id: input.legacyKnowledgeEntryId,
  })
  if (!source)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Legacy knowledge source not found.' })
  if (source.contentModuleId || source.contentRevisionId || source.contentPublicationId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The knowledge source is already native.',
    })
  }
  const sourceSnapshot = snapshot(source)
  const sourceHash = legacyKnowledgeSnapshotHash(sourceSnapshot)
  if (
    source.updatedAt.getTime() !== legacyUpdatedAt.getTime() ||
    sourceHash !== input.expectedLegacySnapshotHash
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Legacy knowledge source changed.' })
  }
  const draftHash = legacyKnowledgeAdoptionDraftHash({
    proposalId: input.proposalId,
    previewHash: input.expectedPreviewHash,
    legacySnapshotHash: sourceHash,
    draft: input.draft,
  })
  const moduleId = legacyKnowledgeAdoptionModuleId({
    tenantId: input.tenantId,
    venueId: input.venueId,
    legacyKnowledgeEntryId: input.legacyKnowledgeEntryId,
    legacySnapshotHash: sourceHash,
  })
  const existing = await loadReceipt(params.db, input)
  if (existing) {
    if (
      existing.moduleId !== moduleId ||
      existing.draftHash !== draftHash ||
      existing.legacySnapshotHash !== sourceHash ||
      existing.proposalUpdatedAt.getTime() !== proposalUpdatedAt.getTime() ||
      existing.legacyKnowledgeUpdatedAt.getTime() !== legacyUpdatedAt.getTime()
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The proposal already has a different adoption receipt.',
      })
    return {
      moduleId,
      revisionId: existing.revisionId,
      version: 1,
      draftHash,
      legacySnapshotHash: sourceHash,
      replayed: true as const,
      requiresExplicitPublication: true as const,
    }
  }
  const previewInput = {
    db: params.db,
    tenantId: input.tenantId,
    venueId: input.venueId,
    proposalId: input.proposalId,
    expectedUpdatedAt: proposalUpdatedAt,
    relation: input.relation,
    desired: input.desired,
  }
  const preview = await previewSemanticVenueUpdateFromProposal(previewInput)
  if (
    preview.previewHash !== input.expectedPreviewHash ||
    preview.targetKnowledgeEntryId !== input.legacyKnowledgeEntryId
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Semantic preview changed.' })
  }
  if (!['CORRECTION', 'SUPERSESSION'].includes(preview.classification)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Only a correction or supersession target can be adopted.',
    })
  }
  const precondition = async (rawTx: unknown) => {
    const tx = rawTx as ScopedDb
    const current = await loadLegacy(tx, {
      tenantId: input.tenantId,
      venueId: input.venueId,
      id: input.legacyKnowledgeEntryId,
    })
    if (
      !current ||
      current.updatedAt.getTime() !== legacyUpdatedAt.getTime() ||
      legacyKnowledgeSnapshotHash(snapshot(current)) !== sourceHash
    ) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Legacy knowledge source changed.' })
    }
    const currentPreview = await previewSemanticVenueUpdateFromProposal({ ...previewInput, db: tx })
    if (currentPreview.previewHash !== input.expectedPreviewHash)
      throw new TRPCError({ code: 'CONFLICT', message: 'Semantic preview changed.' })
  }
  const finalizer = async (rawTx: unknown, result: { revisionId: string; kind: string }) => {
    const tx = rawTx as ScopedDb
    await tx.$executeRaw`
      INSERT INTO legacy_knowledge_universal_content_adoptions (
        tenant_id, venue_id, proposal_id, legacy_knowledge_entry_id, module_id, module_kind,
        revision_id, proposal_updated_at, legacy_knowledge_updated_at, legacy_snapshot,
        legacy_snapshot_hash, draft_hash, created_by
      ) VALUES (
        ${input.tenantId}, ${input.venueId}, ${input.proposalId}::uuid,
        ${input.legacyKnowledgeEntryId}, ${moduleId}, ${result.kind}::"NormalizedContentModuleKind",
        ${result.revisionId}, ${proposalUpdatedAt}, ${legacyUpdatedAt}, ${JSON.stringify(sourceSnapshot)}::jsonb,
        ${sourceHash}, ${draftHash}, ${params.actor.id}
      )
    `
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: params.actor.id,
        actorRole: params.actor.role,
        action: 'legacy-knowledge.adoption-draft-created',
        targetType: 'VenueKnowledgeEntry',
        targetId: input.legacyKnowledgeEntryId,
        beforeState: { legacySnapshotHash: sourceHash, nativeModuleId: null },
        afterState: {
          moduleId,
          revisionId: result.revisionId,
          draftHash,
          publication: 'NOT_PUBLISHED',
        },
      },
      tx,
    )
  }
  try {
    const result = await createUniversalContentAction({
      db: params.db,
      tenantId: input.tenantId,
      venueId: input.venueId,
      moduleId,
      draft: input.draft,
      actor: params.actor,
      precondition,
      finalizer,
    })
    return {
      ...result,
      draftHash,
      legacySnapshotHash: sourceHash,
      replayed: false as const,
      requiresExplicitPublication: true as const,
    }
  } catch (error) {
    const raced = await loadReceipt(params.db, input)
    if (!raced || raced.moduleId !== moduleId || raced.draftHash !== draftHash) throw error
    return {
      moduleId,
      revisionId: raced.revisionId,
      version: 1,
      draftHash,
      legacySnapshotHash: sourceHash,
      replayed: true as const,
      requiresExplicitPublication: true as const,
    }
  }
}
