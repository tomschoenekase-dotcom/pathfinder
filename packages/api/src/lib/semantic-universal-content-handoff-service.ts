import { TRPCError } from '@trpc/server'

import {
  CreateSemanticUniversalContentDraftInput,
  type GeneralizedContentRevisionDraft,
} from '@pathfinder/contracts/universal-content-actions'
import {
  addUniversalContentRevisionAction,
  createUniversalContentAction,
  writeAuditLogStrict,
} from '@pathfinder/db'

import type { TRPCContext } from '../context'
import type { SemanticUpdaterDesiredKnowledge } from './semantic-venue-updater'
import {
  planSemanticUniversalContentHandoff,
  SemanticUniversalContentHandoffError,
  semanticUniversalContentDraft,
  semanticUniversalContentDraftHash,
  semanticUniversalContentModuleId,
} from './semantic-universal-content-handoff'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

type Input = {
  tenantId: string
  venueId: string
  proposalId: string
  expectedProposalUpdatedAt: string
  expectedPreviewHash: string
  relation: 'NEW_FACT' | 'CORRECTS' | 'SUPERSEDES'
  desired: typeof SemanticUpdaterDesiredKnowledge._type
  draft: GeneralizedContentRevisionDraft
}

type ScopedDb = TRPCContext['db']

const handoffSelect = {
  id: true,
  moduleId: true,
  revisionId: true,
  classification: true,
  relation: true,
  previewHash: true,
  draftHash: true,
  proposalUpdatedAt: true,
  expectedBaseRevisionId: true,
  expectedBaseVersion: true,
  revision: { select: { version: true, audience: true, kind: true } },
} as const

function planOrPrecondition(input: Parameters<typeof planSemanticUniversalContentHandoff>[0]) {
  try {
    return planSemanticUniversalContentHandoff(input)
  } catch (error) {
    if (error instanceof SemanticUniversalContentHandoffError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error })
    }
    throw error
  }
}

async function loadTarget(db: ScopedDb, input: { tenantId: string; venueId: string; id: string }) {
  return db.venueKnowledgeEntry.findFirst({
    where: { id: input.id, tenantId: input.tenantId, venueId: input.venueId },
    select: {
      id: true,
      contentModuleId: true,
      contentRevisionId: true,
      contentPublicationId: true,
      contentModule: {
        select: {
          kind: true,
          revisions: {
            orderBy: { version: 'desc' as const },
            take: 1,
            select: { id: true, version: true },
          },
          publications: {
            orderBy: { eventOrder: 'desc' as const },
            take: 1,
            select: { id: true, revisionId: true, action: true },
          },
        },
      },
    },
  })
}

function exactReplay<
  T extends {
    moduleId: string
    classification: string
    relation: string
    previewHash: string
    draftHash: string
    proposalUpdatedAt: Date
    expectedBaseRevisionId: string | null
    expectedBaseVersion: number | null
  },
>(
  existing: T | null,
  expected: {
    moduleId: string
    classification: string
    relation: string
    previewHash: string
    draftHash: string
    proposalUpdatedAt: Date
    expectedBaseRevisionId: string | null
    expectedBaseVersion: number | null
  },
) {
  if (
    !existing ||
    existing.moduleId !== expected.moduleId ||
    existing.classification !== expected.classification ||
    existing.relation !== expected.relation ||
    existing.previewHash !== expected.previewHash ||
    existing.draftHash !== expected.draftHash ||
    !(existing.proposalUpdatedAt instanceof Date) ||
    existing.proposalUpdatedAt.getTime() !== expected.proposalUpdatedAt.getTime() ||
    existing.expectedBaseRevisionId !== expected.expectedBaseRevisionId ||
    existing.expectedBaseVersion !== expected.expectedBaseVersion
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The proposal already belongs to a different universal-content handoff.',
    })
  }
  return existing
}

export async function createSemanticUniversalContentDraftService(params: {
  db: ScopedDb
  actorId: string
  agentActor?: Readonly<{
    agentIdentityId: string
    agentRunId: string
    workerId: string
    credentialId: string
    capability: 'knowledge:draft'
    idempotencyKey: string
    modelProvider?: string
    modelName?: string
  }>
  input: Input
}) {
  const { desired, ...contractInput } = params.input
  const parsed = CreateSemanticUniversalContentDraftInput.parse(contractInput)
  const proposalUpdatedAt = new Date(parsed.expectedProposalUpdatedAt)
  const previewInput = {
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    proposalId: parsed.proposalId,
    expectedUpdatedAt: proposalUpdatedAt,
    relation: parsed.relation,
    desired,
  }
  const approvedProposal = await params.db.knowledgeChangeProposal.findFirst({
    where: { id: parsed.proposalId, tenantId: parsed.tenantId, venueId: parsed.venueId },
    select: { status: true, updatedAt: true },
  })
  if (!approvedProposal) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge proposal not found.' })
  }
  if (approvedProposal.updatedAt.getTime() !== proposalUpdatedAt.getTime()) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Knowledge proposal changed.' })
  }
  if (approvedProposal.status !== 'APPROVED') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Human approval is required.' })
  }
  const draft = semanticUniversalContentDraft({
    draft: parsed.draft,
    proposalId: parsed.proposalId,
    proposalUpdatedAt,
    previewHash: parsed.expectedPreviewHash,
  })
  const additionModuleId = semanticUniversalContentModuleId({
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    proposalId: parsed.proposalId,
    previewHash: parsed.expectedPreviewHash,
  })
  const existing = await params.db.knowledgeProposalUniversalContentHandoff.findFirst({
    where: { proposalId: parsed.proposalId, tenantId: parsed.tenantId, venueId: parsed.venueId },
    select: handoffSelect,
  })
  if (existing) {
    const replayDraftHash = semanticUniversalContentDraftHash({
      proposalId: parsed.proposalId,
      previewHash: parsed.expectedPreviewHash,
      relation: parsed.relation,
      targetModuleId: existing.expectedBaseRevisionId ? existing.moduleId : null,
      expectedBaseRevisionId: existing.expectedBaseRevisionId,
      expectedBaseVersion: existing.expectedBaseVersion,
      draft,
    })
    const replay = exactReplay(existing, {
      moduleId: existing.expectedBaseRevisionId ? existing.moduleId : additionModuleId,
      classification: existing.classification,
      relation: parsed.relation,
      previewHash: parsed.expectedPreviewHash,
      draftHash: replayDraftHash,
      proposalUpdatedAt,
      expectedBaseRevisionId: existing.expectedBaseRevisionId,
      expectedBaseVersion: existing.expectedBaseVersion,
    })
    return {
      moduleId: replay.moduleId,
      revisionId: replay.revisionId,
      version: replay.revision.version,
      classification: replay.classification,
      draftHash: replay.draftHash,
      replayed: true as const,
    }
  }
  const preview = await previewSemanticVenueUpdateFromProposal({ db: params.db, ...previewInput })
  if (preview.previewHash !== parsed.expectedPreviewHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Semantic preview changed; recompute it before creating a typed draft.',
    })
  }
  if (!['ADDITION', 'CORRECTION', 'SUPERSESSION'].includes(preview.classification)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This semantic classification cannot create a universal-content draft.',
    })
  }
  const target = preview.targetKnowledgeEntryId
    ? await loadTarget(params.db, {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        id: preview.targetKnowledgeEntryId,
      })
    : null
  const latestRevision = target?.contentModule?.revisions[0] ?? null
  const latestPublication = target?.contentModule?.publications[0] ?? null
  const plan = planOrPrecondition({
    classification: preview.classification as 'ADDITION' | 'CORRECTION' | 'SUPERSESSION',
    relation: parsed.relation,
    draft,
    additionModuleId,
    target: target
      ? {
          knowledgeEntryId: target.id,
          moduleId: target.contentModuleId,
          revisionId: target.contentRevisionId,
          publicationId: target.contentPublicationId,
          moduleKind: target.contentModule?.kind ?? null,
          latestVersion: latestRevision?.version ?? null,
          latestRevisionId: latestRevision?.id ?? null,
          latestPublicationId: latestPublication?.id ?? null,
          latestPublicationRevisionId: latestPublication?.revisionId ?? null,
          latestPublicationAction: latestPublication?.action ?? null,
        }
      : null,
  })
  const draftHash = semanticUniversalContentDraftHash({
    proposalId: parsed.proposalId,
    previewHash: preview.previewHash,
    relation: parsed.relation,
    targetModuleId: plan.action === 'APPEND' ? plan.moduleId : null,
    expectedBaseRevisionId: plan.expectedBaseRevisionId,
    expectedBaseVersion: plan.expectedBaseVersion,
    draft,
  })
  const expected = {
    moduleId: plan.moduleId,
    classification: preview.classification,
    relation: parsed.relation,
    previewHash: preview.previewHash,
    draftHash,
    proposalUpdatedAt,
    expectedBaseRevisionId: plan.expectedBaseRevisionId,
    expectedBaseVersion: plan.expectedBaseVersion,
  }
  const precondition = async (rawTx: unknown) => {
    const tx = rawTx as ScopedDb
    const claimed = await tx.knowledgeProposalUniversalContentHandoff.findFirst({
      where: { proposalId: parsed.proposalId, tenantId: parsed.tenantId, venueId: parsed.venueId },
      select: { id: true },
    })
    if (claimed) {
      throw new TRPCError({ code: 'CONFLICT', message: 'The proposal handoff already exists.' })
    }
    const current = await previewSemanticVenueUpdateFromProposal({ db: tx, ...previewInput })
    if (
      current.proposalStatus !== 'APPROVED' ||
      current.previewHash !== preview.previewHash ||
      current.classification !== preview.classification
    ) {
      throw new TRPCError({ code: 'CONFLICT', message: 'The approved proposal changed.' })
    }
    const currentTarget = current.targetKnowledgeEntryId
      ? await loadTarget(tx, {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          id: current.targetKnowledgeEntryId,
        })
      : null
    const currentLatestRevision = currentTarget?.contentModule?.revisions[0] ?? null
    const currentLatestPublication = currentTarget?.contentModule?.publications[0] ?? null
    const currentPlan = planOrPrecondition({
      classification: current.classification as 'ADDITION' | 'CORRECTION' | 'SUPERSESSION',
      relation: parsed.relation,
      draft,
      additionModuleId,
      target: currentTarget
        ? {
            knowledgeEntryId: currentTarget.id,
            moduleId: currentTarget.contentModuleId,
            revisionId: currentTarget.contentRevisionId,
            publicationId: currentTarget.contentPublicationId,
            moduleKind: currentTarget.contentModule?.kind ?? null,
            latestVersion: currentLatestRevision?.version ?? null,
            latestRevisionId: currentLatestRevision?.id ?? null,
            latestPublicationId: currentLatestPublication?.id ?? null,
            latestPublicationRevisionId: currentLatestPublication?.revisionId ?? null,
            latestPublicationAction: currentLatestPublication?.action ?? null,
          }
        : null,
    })
    if (
      currentPlan.action !== plan.action ||
      currentPlan.moduleId !== plan.moduleId ||
      currentPlan.expectedBaseRevisionId !== plan.expectedBaseRevisionId ||
      currentPlan.expectedBaseVersion !== plan.expectedBaseVersion
    ) {
      throw new TRPCError({ code: 'CONFLICT', message: 'The universal-content target changed.' })
    }
  }
  const finalizer = async (rawTx: unknown, result: { revisionId: string; kind: string }) => {
    const tx = rawTx as ScopedDb
    await tx.knowledgeProposalUniversalContentHandoff.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        proposalId: parsed.proposalId,
        moduleId: plan.moduleId,
        moduleKind: result.kind as never,
        revisionId: result.revisionId,
        classification: preview.classification,
        relation: parsed.relation,
        previewHash: preview.previewHash,
        draftHash,
        proposalUpdatedAt,
        expectedBaseRevisionId: plan.expectedBaseRevisionId,
        expectedBaseVersion: plan.expectedBaseVersion,
        createdBy: params.actorId,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        actorId: params.actorId,
        actorRole: params.agentActor ? 'AGENT' : 'PLATFORM_ADMIN',
        action: 'knowledge-proposal.semantic-universal-content-draft-created-and-linked',
        targetType: 'KnowledgeChangeProposal',
        targetId: parsed.proposalId,
        beforeState: { universalContentLinked: false },
        afterState: {
          universalContentLinked: true,
          moduleId: plan.moduleId,
          revisionId: result.revisionId,
          classification: preview.classification,
          previewHash: preview.previewHash,
          draftHash,
          autoPublished: false,
        },
      },
      tx,
    )
  }
  try {
    const actor = params.agentActor
      ? ({
          type: 'AGENT',
          id: params.actorId,
          role: 'AGENT',
          authorization: 'APPROVED_SEMANTIC_PROPOSAL',
        } as const)
      : ({ type: 'HUMAN', id: params.actorId, role: 'PLATFORM_ADMIN' } as const)
    const result =
      plan.action === 'CREATE'
        ? await createUniversalContentAction({
            db: params.db,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
            moduleId: plan.moduleId,
            draft,
            actor,
            finalizer,
            precondition,
          })
        : await addUniversalContentRevisionAction({
            db: params.db,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
            moduleId: plan.moduleId,
            expectedLatestVersion: plan.expectedBaseVersion,
            draft,
            actor,
            finalizer,
            precondition,
          })
    return {
      ...result,
      classification: preview.classification,
      draftHash,
      replayed: false as const,
    }
  } catch (error) {
    const raced = await params.db.knowledgeProposalUniversalContentHandoff.findFirst({
      where: { proposalId: parsed.proposalId, tenantId: parsed.tenantId, venueId: parsed.venueId },
      select: handoffSelect,
    })
    if (!raced) throw error
    const replay = exactReplay(raced, expected)
    return {
      moduleId: replay.moduleId,
      revisionId: replay.revisionId,
      version: replay.revision.version,
      classification: replay.classification,
      draftHash: replay.draftHash,
      replayed: true as const,
    }
  }
}
