import { TRPCError } from '@trpc/server'

import type { TRPCContext } from '../context'

type ScopedDb = TRPCContext['db']
type NativeModule = {
  kind: string
  revisions: Array<{ id: string; version: number }>
  publications: Array<{ id: string; revisionId: string; action: 'PUBLISH' | 'WITHDRAW' }>
}
type CurrentModuleStatus = {
  latestRevision: { id: string; version: number } | null
  latestPublication: { id: string; revisionId: string; action: 'PUBLISH' | 'WITHDRAW' } | null
}

export type SupportProposalAuthoringState =
  | ({
      state: 'OWN_UNIVERSAL_RECEIPT'
      moduleId: string
      revisionId: string
      moduleKind: string
    } & CurrentModuleStatus)
  | { state: 'NO_TARGET'; proposalStatus: string }
  | ({
      state: 'OWN_ADOPTION_RECEIPT'
      moduleId: string
      revisionId: string
      moduleKind: string
      activationPublicationId: string | null
    } & CurrentModuleStatus)
  | { state: 'OTHER_ADOPTION_DRAFT' }
  | {
      state: 'NATIVE_READY'
      moduleId: string
      moduleKind: string
      expectedBaseRevisionId: string
      expectedBaseVersion: number
      publicationId: string
    }
  | {
      state: 'NATIVE_NOT_READY'
      reason:
        | 'TARGET_NOT_FOUND'
        | 'PARTIAL_NATIVE_LINK'
        | 'CONFLICTING_NATIVE_IDENTITIES'
        | 'UNPUBLISHED_OR_STALE_NATIVE'
    }
  | { state: 'LEGACY_UNADOPTED' }

function nativeReadiness(input: {
  moduleId: string
  revisionId: string
  publicationId: string
  module: NativeModule | null
}): Extract<SupportProposalAuthoringState, { state: 'NATIVE_READY' }> | null {
  const latestRevision = input.module?.revisions[0] ?? null
  const latestPublication = input.module?.publications[0] ?? null
  if (
    !input.module ||
    !latestRevision ||
    latestRevision.version < 1 ||
    !latestPublication ||
    latestRevision.id !== input.revisionId ||
    latestPublication.id !== input.publicationId ||
    latestPublication.revisionId !== input.revisionId ||
    latestPublication.action !== 'PUBLISH'
  ) {
    return null
  }
  return {
    state: 'NATIVE_READY',
    moduleId: input.moduleId,
    moduleKind: input.module.kind,
    expectedBaseRevisionId: input.revisionId,
    expectedBaseVersion: latestRevision.version,
    publicationId: input.publicationId,
  }
}

function currentModuleStatus(module: NativeModule | null): CurrentModuleStatus {
  return {
    latestRevision: module?.revisions[0] ?? null,
    latestPublication: module?.publications[0] ?? null,
  }
}

const moduleSelect = {
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
} as const

/**
 * Reports durable authoring state for one scoped proposal. The state does not grant draft or
 * publication authority; mutations must recheck their own receipts and version preconditions.
 */
export async function resolveSupportProposalAuthoringState(params: {
  db: ScopedDb
  input: { tenantId: string; venueId: string; proposalId: string; expectedUpdatedAt: Date }
}): Promise<SupportProposalAuthoringState> {
  const { db, input } = params
  const proposal = await db.knowledgeChangeProposal.findFirst({
    where: { id: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
    select: { status: true, updatedAt: true, targetKnowledgeEntryId: true },
  })
  if (!proposal)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge proposal not found.' })
  if (proposal.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
    throw new TRPCError({ code: 'CONFLICT', message: 'Knowledge proposal changed.' })

  const ownAdoption = await db.legacyKnowledgeUniversalContentAdoption.findFirst({
    where: { proposalId: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
    select: {
      moduleId: true,
      revisionId: true,
      moduleKind: true,
      activation: { select: { publicationId: true } },
      module: { select: moduleSelect },
    },
  })
  if (ownAdoption) {
    return {
      state: 'OWN_ADOPTION_RECEIPT',
      moduleId: ownAdoption.moduleId,
      revisionId: ownAdoption.revisionId,
      moduleKind: ownAdoption.moduleKind,
      activationPublicationId: ownAdoption.activation?.publicationId ?? null,
      ...currentModuleStatus(ownAdoption.module),
    }
  }

  const universal = await db.knowledgeProposalUniversalContentHandoff.findFirst({
    where: { proposalId: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
    select: {
      moduleId: true,
      revisionId: true,
      moduleKind: true,
      module: { select: moduleSelect },
    },
  })
  if (universal) {
    return {
      state: 'OWN_UNIVERSAL_RECEIPT',
      moduleId: universal.moduleId,
      revisionId: universal.revisionId,
      moduleKind: universal.moduleKind,
      ...currentModuleStatus(universal.module),
    }
  }
  if (!proposal.targetKnowledgeEntryId)
    return { state: 'NO_TARGET', proposalStatus: proposal.status }

  const target = await db.venueKnowledgeEntry.findFirst({
    where: {
      id: proposal.targetKnowledgeEntryId,
      tenantId: input.tenantId,
      venueId: input.venueId,
    },
    select: {
      contentModuleId: true,
      contentRevisionId: true,
      contentPublicationId: true,
      contentModule: { select: moduleSelect },
    },
  })
  if (!target) return { state: 'NATIVE_NOT_READY', reason: 'TARGET_NOT_FOUND' }

  const adoption = await db.legacyKnowledgeUniversalContentAdoption.findFirst({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      legacyKnowledgeEntryId: proposal.targetKnowledgeEntryId,
    },
    select: {
      proposalId: true,
      moduleId: true,
      moduleKind: true,
      revisionId: true,
      activation: { select: { publicationId: true, revisionId: true } },
      module: { select: moduleSelect },
    },
  })
  if (adoption?.proposalId === input.proposalId) {
    return {
      state: 'OWN_ADOPTION_RECEIPT',
      moduleId: adoption.moduleId,
      revisionId: adoption.revisionId,
      moduleKind: adoption.moduleKind,
      activationPublicationId: adoption.activation?.publicationId ?? null,
      ...currentModuleStatus(adoption.module),
    }
  }

  const directLinks = [
    target.contentModuleId,
    target.contentRevisionId,
    target.contentPublicationId,
  ]
  const directCount = directLinks.filter((value) => value != null).length
  if (directCount > 0 && directCount < 3)
    return { state: 'NATIVE_NOT_READY', reason: 'PARTIAL_NATIVE_LINK' }
  if (adoption && !adoption.activation) return { state: 'OTHER_ADOPTION_DRAFT' }

  const direct =
    directCount === 3
      ? nativeReadiness({
          moduleId: target.contentModuleId!,
          revisionId: target.contentRevisionId!,
          publicationId: target.contentPublicationId!,
          module: target.contentModule,
        })
      : null
  const adopted = adoption?.activation
    ? nativeReadiness({
        moduleId: adoption.moduleId,
        revisionId: adoption.activation.revisionId,
        publicationId: adoption.activation.publicationId,
        module: adoption.module,
      })
    : null
  if (directCount === 3 && adoption?.activation) {
    if (
      target.contentModuleId !== adoption.moduleId ||
      target.contentRevisionId !== adoption.activation.revisionId ||
      target.contentPublicationId !== adoption.activation.publicationId
    ) {
      return { state: 'NATIVE_NOT_READY', reason: 'CONFLICTING_NATIVE_IDENTITIES' }
    }
    if (!direct || !adopted)
      return { state: 'NATIVE_NOT_READY', reason: 'UNPUBLISHED_OR_STALE_NATIVE' }
    return direct
  }
  if (direct) return direct
  if (adopted) return adopted
  if (directCount === 3 || adoption?.activation)
    return { state: 'NATIVE_NOT_READY', reason: 'UNPUBLISHED_OR_STALE_NATIVE' }
  return { state: 'LEGACY_UNADOPTED' }
}
