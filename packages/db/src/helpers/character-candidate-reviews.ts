import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  CustomCharacterFactoryActionError,
  prepareCharacterFactoryJobInTransaction,
  type CharacterFactoryTransactionClient,
} from './custom-character-factory-actions'

type Actor = { id: string; role: 'PLATFORM_ADMIN' | 'AGENT'; type: 'HUMAN' | 'AGENT' }
type Client = Pick<
  typeof db,
  | '$transaction'
  | 'customCharacter'
  | 'characterCandidateReviewBrief'
  | 'characterCandidateReviewDecision'
>

const identifier = z.string().trim().min(1).max(191)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const submitSchema = z
  .object({
    tenantId: identifier,
    venueId: identifier,
    characterId: identifier,
    brief: z.string().trim().min(1).max(4_000),
    rationale: z.string().trim().min(1).max(2_000),
    sourceProvenance: z.enum(['GENERATED', 'IMPORTED', 'IMPORTED_FIXTURE']),
    actor: z
      .object({
        id: identifier,
        role: z.enum(['PLATFORM_ADMIN', 'AGENT']),
        type: z.enum(['HUMAN', 'AGENT']),
      })
      .strict(),
  })
  .strict()
const decisionSchema = z
  .object({
    briefId: identifier,
    tenantId: identifier,
    venueId: identifier,
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    expectedArtifactFingerprint: sha256,
    operationId: identifier,
    decision: z.enum(['ACCEPT', 'REJECT', 'REVISE']),
    revisionRequest: z.string().trim().min(1).max(2_000).optional(),
    actor: z
      .object({ id: identifier, role: z.literal('PLATFORM_ADMIN'), type: z.literal('HUMAN') })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.decision === 'REVISE') !== (value.revisionRequest !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['revisionRequest'],
        message: 'Only REVISE requires revision instructions.',
      })
  })

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

export function characterCandidateArtifactFingerprint(candidate: {
  version: number
  revision: number
  assetStorageReference: unknown
  previewStorageReference: unknown
  capabilityMetadata: unknown
}) {
  return fingerprint({
    version: candidate.version,
    revision: candidate.revision,
    assetStorageReference: candidate.assetStorageReference,
    previewStorageReference: candidate.previewStorageReference,
    capabilityMetadata: candidate.capabilityMetadata,
  })
}

function isValidCandidateArtifact(candidate: {
  assetStorageReference: unknown
  capabilityMetadata: unknown
}) {
  const reference = candidate.assetStorageReference as Record<string, unknown> | null
  const metadata = candidate.capabilityMetadata as {
    characterFactory?: { spec?: { status?: unknown } }
  } | null
  return (
    (reference?.kind === 'character-bundle-v1' ||
      reference?.kind === 'character-bundle-content-v1') &&
    typeof reference.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(reference.sha256) &&
    metadata?.characterFactory?.spec?.status === 'candidate'
  )
}

function requireSubmitActor(actor: Actor) {
  if (
    (actor.type === 'AGENT' && actor.role !== 'AGENT') ||
    (actor.type === 'HUMAN' && actor.role !== 'PLATFORM_ADMIN')
  )
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'Candidate briefs require a verified producer actor.',
    )
}

async function lockCandidate(
  tx: CharacterFactoryTransactionClient,
  input: { tenantId: string; venueId: string; characterId: string },
) {
  await tx.$queryRaw`SELECT "id" FROM "custom_characters" WHERE "id" = ${input.characterId} AND "tenant_id" = ${input.tenantId} AND "venue_id" = ${input.venueId} FOR UPDATE`
  const candidate = await tx.customCharacter.findFirst({
    where: { id: input.characterId, tenantId: input.tenantId, venueId: input.venueId },
    select: {
      id: true,
      version: true,
      revision: true,
      status: true,
      assetStorageReference: true,
      previewStorageReference: true,
      capabilityMetadata: true,
    },
  })
  if (!candidate)
    throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Character candidate not found.')
  if (candidate.status !== 'REVIEW')
    throw new CustomCharacterFactoryActionError(
      'CONFLICT',
      'Only review-state character candidates can be submitted.',
    )
  return candidate
}

export async function submitCharacterCandidateReviewBrief(
  rawInput: z.input<typeof submitSchema>,
  client: Client = db,
) {
  let input: z.output<typeof submitSchema>
  try {
    input = submitSchema.parse(rawInput)
  } catch (error) {
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      error instanceof Error ? error.message : 'Invalid candidate review brief.',
    )
  }
  requireSubmitActor(input.actor)
  try {
    return await client.$transaction(async (tx) => {
      const candidate = await lockCandidate(tx, input)
      const artifactFingerprint = characterCandidateArtifactFingerprint(candidate)
      const existing = await tx.characterCandidateReviewBrief.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          customCharacterId: input.characterId,
          candidateVersion: candidate.version,
          candidateRevision: candidate.revision,
          artifactFingerprint,
        },
      })
      if (existing) {
        if (
          existing.brief !== input.brief ||
          existing.rationale !== input.rationale ||
          existing.sourceProvenance !== input.sourceProvenance
        )
          throw new CustomCharacterFactoryActionError(
            'CONFLICT',
            'This exact candidate snapshot already has a different review brief.',
          )
        return { brief: existing, replayed: true as const }
      }
      const brief = await tx.characterCandidateReviewBrief.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          customCharacterId: input.characterId,
          candidateVersion: candidate.version,
          candidateRevision: candidate.revision,
          artifactFingerprint,
          brief: input.brief,
          rationale: input.rationale,
          sourceProvenance: input.sourceProvenance,
          createdBy: input.actor.id,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          actorType: input.actor.type,
          action: 'character-candidate.review-brief-submitted',
          targetType: 'CharacterCandidateReviewBrief',
          targetId: brief.id,
          afterState: {
            venueId: input.venueId,
            customCharacterId: input.characterId,
            candidateVersion: candidate.version,
            candidateRevision: candidate.revision,
            artifactFingerprint,
            sourceProvenance: input.sourceProvenance,
          },
        },
        tx,
      )
      return { brief, replayed: false as const }
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      return client.$transaction(async (tx) => {
        const candidate = await lockCandidate(tx, input)
        const artifactFingerprint = characterCandidateArtifactFingerprint(candidate)
        const existing = await tx.characterCandidateReviewBrief.findFirst({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            customCharacterId: input.characterId,
            candidateVersion: candidate.version,
            candidateRevision: candidate.revision,
            artifactFingerprint,
          },
        })
        if (
          existing &&
          existing.brief === input.brief &&
          existing.rationale === input.rationale &&
          existing.sourceProvenance === input.sourceProvenance
        )
          return { brief: existing, replayed: true as const }
        throw new CustomCharacterFactoryActionError(
          'CONFLICT',
          'This exact candidate snapshot already has a different review brief.',
        )
      })
    }
    throw error
  }
}

export async function readCharacterCandidateReviewBrief(
  input: { tenantId: string; venueId: string; briefId: string },
  client: Pick<typeof db, 'characterCandidateReviewBrief' | 'customCharacter'> = db,
) {
  const scope = z
    .object({ tenantId: identifier, venueId: identifier, briefId: identifier })
    .strict()
    .parse(input)
  const brief = await client.characterCandidateReviewBrief.findFirst({
    where: { id: scope.briefId, tenantId: scope.tenantId, venueId: scope.venueId },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      customCharacterId: true,
      candidateVersion: true,
      candidateRevision: true,
      artifactFingerprint: true,
      brief: true,
      rationale: true,
      sourceProvenance: true,
      createdBy: true,
      createdAt: true,
      decision: {
        select: {
          id: true,
          operationId: true,
          decision: true,
          revisionRequest: true,
          resultingJobId: true,
          decidedBy: true,
          decidedAt: true,
          resultingJob: {
            select: { id: true, requestId: true, action: true, status: true },
          },
        },
      },
    },
  })
  if (!brief)
    throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Candidate review brief not found.')
  const candidate = await client.customCharacter.findFirst({
    where: {
      id: brief.customCharacterId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
    },
    select: {
      displayName: true,
      status: true,
      version: true,
      revision: true,
      assetStorageReference: true,
      previewStorageReference: true,
      capabilityMetadata: true,
    },
  })
  const current = Boolean(
    candidate &&
    candidate.status === 'REVIEW' &&
    candidate.version === brief.candidateVersion &&
    candidate.revision === brief.candidateRevision &&
    characterCandidateArtifactFingerprint(candidate) === brief.artifactFingerprint,
  )
  return {
    ...brief,
    characterId: brief.customCharacterId,
    displayName: candidate?.displayName ?? null,
    version: brief.candidateVersion,
    revision: brief.candidateRevision,
    provenance: brief.sourceProvenance,
    current,
  }
}

export async function decideCharacterCandidateReview(
  rawInput: z.input<typeof decisionSchema>,
  client: Client = db,
) {
  let input: z.output<typeof decisionSchema>
  try {
    input = decisionSchema.parse(rawInput)
  } catch (error) {
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      error instanceof Error ? error.message : 'Invalid review decision.',
    )
  }
  const requestFingerprint = fingerprint({
    briefId: input.briefId,
    tenantId: input.tenantId,
    venueId: input.venueId,
    expectedVersion: input.expectedVersion,
    expectedRevision: input.expectedRevision,
    expectedArtifactFingerprint: input.expectedArtifactFingerprint,
    decision: input.decision,
    revisionRequest: input.revisionRequest ?? null,
  })
  const replay = (
    operation: Prisma.CharacterCandidateReviewDecisionGetPayload<{
      include: { resultingJob: true }
    }>,
  ) => {
    if (operation.requestFingerprint !== requestFingerprint)
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Operation ID is bound to another candidate decision.',
      )
    return { decision: operation, resultingJob: operation.resultingJob, replayed: true as const }
  }
  try {
    return await client.$transaction(async (tx) => {
      const operation = await tx.characterCandidateReviewDecision.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        include: { resultingJob: true },
      })
      if (operation) return replay(operation)
      const brief = await tx.characterCandidateReviewBrief.findFirst({
        where: { id: input.briefId, tenantId: input.tenantId, venueId: input.venueId },
      })
      if (!brief)
        throw new CustomCharacterFactoryActionError(
          'NOT_FOUND',
          'Candidate review brief not found.',
        )
      const candidate = await lockCandidate(tx, { ...input, characterId: brief.customCharacterId })
      const operationAfterLock = await tx.characterCandidateReviewDecision.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        include: { resultingJob: true },
      })
      if (operationAfterLock) return replay(operationAfterLock)
      const currentFingerprint = characterCandidateArtifactFingerprint(candidate)
      if (
        brief.candidateVersion !== input.expectedVersion ||
        brief.candidateRevision !== input.expectedRevision ||
        brief.artifactFingerprint !== input.expectedArtifactFingerprint ||
        candidate.version !== input.expectedVersion ||
        candidate.revision !== input.expectedRevision ||
        currentFingerprint !== input.expectedArtifactFingerprint
      )
        throw new CustomCharacterFactoryActionError(
          'CONFLICT',
          'Character art changed; refresh before deciding.',
        )
      if (input.decision === 'ACCEPT' && !isValidCandidateArtifact(candidate))
        throw new CustomCharacterFactoryActionError(
          'CONFLICT',
          'Only a candidate with a verified character bundle can be accepted for export.',
        )
      const prior = await tx.characterCandidateReviewDecision.findFirst({
        where: { briefId: brief.id },
      })
      if (prior)
        throw new CustomCharacterFactoryActionError(
          'CONFLICT',
          'This candidate brief already has a decision.',
        )
      const prepared =
        input.decision === 'REJECT'
          ? null
          : await prepareCharacterFactoryJobInTransaction(
              {
                tenantId: input.tenantId,
                venueId: input.venueId,
                requestId: `candidate-review:${fingerprint({
                  tenantId: input.tenantId,
                  operationId: input.operationId,
                })}`,
                action: input.decision === 'ACCEPT' ? 'EXPORT' : 'REVISE',
                requestPayload:
                  input.decision === 'ACCEPT'
                    ? {
                        includeEditableSource: true,
                        workflowStage: 'ANIMATION_PREPARATION',
                        approvedAppearanceFingerprint: input.expectedArtifactFingerprint,
                        motionCapability: 'rigid-source',
                        publicationAuthorized: false,
                      }
                    : { instructions: input.revisionRequest! },
                characterId: brief.customCharacterId,
                baseVersion: input.expectedVersion,
                baseRevision: input.expectedRevision,
                actor: input.actor,
              },
              tx,
            )
      if (prepared?.replayed)
        throw new CustomCharacterFactoryActionError(
          'CONFLICT',
          'Candidate review job request was already used without a matching decision receipt.',
        )
      const decision = await tx.characterCandidateReviewDecision.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          briefId: brief.id,
          customCharacterId: brief.customCharacterId,
          candidateVersion: input.expectedVersion,
          candidateRevision: input.expectedRevision,
          artifactFingerprint: input.expectedArtifactFingerprint,
          operationId: input.operationId,
          requestFingerprint,
          decision: input.decision,
          ...(input.revisionRequest === undefined
            ? {}
            : { revisionRequest: input.revisionRequest }),
          ...(prepared ? { resultingJobId: prepared.job.id } : {}),
          decidedBy: input.actor.id,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          actorType: input.actor.type,
          idempotencyKey: input.operationId,
          action: 'character-candidate.review-decided',
          targetType: 'CharacterCandidateReviewDecision',
          targetId: decision.id,
          afterState: {
            venueId: input.venueId,
            briefId: brief.id,
            customCharacterId: brief.customCharacterId,
            candidateVersion: input.expectedVersion,
            candidateRevision: input.expectedRevision,
            artifactFingerprint: input.expectedArtifactFingerprint,
            decision: input.decision,
            resultingJobId: decision.resultingJobId,
          },
        },
        tx,
      )
      return { decision, resultingJob: prepared?.job ?? null, replayed: false as const }
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      const operation = await client.characterCandidateReviewDecision.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        include: { resultingJob: true },
      })
      if (operation) return replay(operation)
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Candidate decision changed; refresh before retrying.',
      )
    }
    throw error
  }
}
