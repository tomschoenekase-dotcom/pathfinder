import { createHash } from 'node:crypto'

import {
  GeneralizedContentRevisionDraft,
  type GeneralizedContentRevisionDraft as GeneralizedContentRevisionDraftValue,
} from '@pathfinder/contracts/universal-content-actions'

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function semanticUniversalContentModuleId(input: {
  tenantId: string
  venueId: string
  proposalId: string
  previewHash: string
}) {
  return deterministicUuid(
    `pathfinder:semantic-universal-content:v1:${input.tenantId}:${input.venueId}:${input.proposalId}:${input.previewHash}`,
  )
}

/** Preserve caller-supplied source evidence and add the exact approved proposal preview. */
export function semanticUniversalContentDraft(input: {
  draft: GeneralizedContentRevisionDraftValue
  proposalId: string
  proposalUpdatedAt: Date
  previewHash: string
}): GeneralizedContentRevisionDraftValue {
  const draft = GeneralizedContentRevisionDraft.parse(input.draft)
  const proposalEvidence = {
    sourceId: `knowledge-proposal:${input.proposalId}`,
    locator: `approved-preview:${input.previewHash}`,
    capturedAt: input.proposalUpdatedAt.toISOString(),
    excerptHash: input.previewHash,
  }
  const evidence = draft.evidence.filter(
    (item) =>
      item.sourceId !== proposalEvidence.sourceId || item.locator !== proposalEvidence.locator,
  )
  if (evidence.length >= 100) {
    throw new Error('Semantic handoff must reserve one evidence slot for the approved proposal.')
  }
  return GeneralizedContentRevisionDraft.parse({
    ...draft,
    evidence: [...evidence, proposalEvidence],
  })
}

export function semanticUniversalContentDraftHash(input: {
  proposalId: string
  previewHash: string
  relation: 'NEW_FACT' | 'CORRECTS' | 'SUPERSEDES'
  targetModuleId: string | null
  expectedBaseRevisionId: string | null
  expectedBaseVersion: number | null
  draft: GeneralizedContentRevisionDraftValue
}) {
  return createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, ...input }))
    .digest('hex')
}

export class SemanticUniversalContentHandoffError extends Error {
  constructor(
    readonly code:
      | 'CLASSIFICATION_MISMATCH'
      | 'TARGET_REQUIRED'
      | 'LEGACY_ADOPTION_REQUIRED'
      | 'STALE_TARGET'
      | 'KIND_MISMATCH',
    message: string,
  ) {
    super(message)
    this.name = 'SemanticUniversalContentHandoffError'
  }
}

export type SemanticUniversalTarget = {
  knowledgeEntryId: string
  moduleId: string | null
  revisionId: string | null
  publicationId: string | null
  moduleKind: GeneralizedContentRevisionDraftValue['payload']['kind'] | null
  latestVersion: number | null
  latestRevisionId: string | null
  latestPublicationId: string | null
  latestPublicationRevisionId: string | null
  latestPublicationAction: 'PUBLISH' | 'WITHDRAW' | null
}

export function planSemanticUniversalContentHandoff(input: {
  classification: 'ADDITION' | 'CORRECTION' | 'SUPERSESSION'
  relation: 'NEW_FACT' | 'CORRECTS' | 'SUPERSEDES'
  draft: GeneralizedContentRevisionDraftValue
  target: SemanticUniversalTarget | null
  additionModuleId: string
}) {
  const kind = GeneralizedContentRevisionDraft.parse(input.draft).payload.kind
  if (input.classification === 'ADDITION') {
    if (input.relation !== 'NEW_FACT' || input.target) {
      throw new SemanticUniversalContentHandoffError(
        'CLASSIFICATION_MISMATCH',
        'Only an untargeted NEW_FACT may create a universal content module.',
      )
    }
    return {
      action: 'CREATE' as const,
      moduleId: input.additionModuleId,
      expectedBaseRevisionId: null,
      expectedBaseVersion: null,
    }
  }
  const expectedRelation = input.classification === 'CORRECTION' ? 'CORRECTS' : 'SUPERSEDES'
  if (input.relation !== expectedRelation) {
    throw new SemanticUniversalContentHandoffError(
      'CLASSIFICATION_MISMATCH',
      `A ${input.classification.toLowerCase()} requires ${expectedRelation}.`,
    )
  }
  if (!input.target) {
    throw new SemanticUniversalContentHandoffError(
      'TARGET_REQUIRED',
      'A correction or supersession requires an exact target.',
    )
  }
  const target = input.target
  if (!target.moduleId || !target.revisionId || !target.publicationId || !target.moduleKind) {
    throw new SemanticUniversalContentHandoffError(
      'LEGACY_ADOPTION_REQUIRED',
      'This legacy target must be adopted into universal content before appending a typed revision.',
    )
  }
  if (
    target.latestPublicationAction !== 'PUBLISH' ||
    target.latestRevisionId !== target.revisionId ||
    target.latestPublicationRevisionId !== target.revisionId ||
    target.latestPublicationId !== target.publicationId ||
    !target.latestVersion
  ) {
    throw new SemanticUniversalContentHandoffError(
      'STALE_TARGET',
      'The target is not the exact latest published universal content revision.',
    )
  }
  if (target.moduleKind !== kind) {
    throw new SemanticUniversalContentHandoffError(
      'KIND_MISMATCH',
      'A universal content module kind cannot be changed by correction or supersession.',
    )
  }
  return {
    action: 'APPEND' as const,
    moduleId: target.moduleId,
    expectedBaseRevisionId: target.revisionId,
    expectedBaseVersion: target.latestVersion,
  }
}
