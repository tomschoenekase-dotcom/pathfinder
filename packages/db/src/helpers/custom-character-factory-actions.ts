import type { Prisma } from '@prisma/client'
import {
  FACTORY_STATES,
  resolveRig,
  sanitizeImportedSource,
  type CharacterSpec,
} from '@pathfinder/character-factory'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export class CustomCharacterFactoryActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
  }
}

type Actor = { id: string; role: 'PLATFORM_ADMIN' | 'AGENT'; type?: 'HUMAN' | 'AGENT' }
type Client = Pick<typeof db, '$transaction' | 'characterFactoryJob'>
export const CHARACTER_FACTORY_JOB_LEASE_MS = 60_000

type JobAction = 'CREATE_FROM_IMPORT' | 'REVISE' | 'INSPECT' | 'PREVIEW' | 'VALIDATE' | 'EXPORT'

const identifier = z.string().trim().min(1).max(191)
const boundedText = z.string().trim().min(1).max(2_000)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const verifiedArtifactReferenceSchema = z
  .object({
    kind: z.literal('character-bundle-v1'),
    bucket: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u),
    objectKey: z.string().min(1).max(1_000),
    sha256,
    byteLength: z.number().int().positive().max(12_000_000),
    mediaType: z.literal('application/vnd.pathfinder.character+json'),
    characterId: identifier,
    characterVersion: z.number().int().positive(),
    versionId: z.string().min(1).max(1_000),
  })
  .strict()
const requestPayloadByAction = {
  CREATE_FROM_IMPORT: z
    .object({
      characterId: identifier,
      sourceAssetReference: z.string().trim().min(1).max(1_000),
      sourceSha256: sha256,
    })
    .strict(),
  REVISE: z
    .object({
      instructions: boundedText,
      protectedTraits: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
    })
    .strict(),
  INSPECT: z.object({}).strict(),
  PREVIEW: z
    .object({
      state: z.enum([
        'idle',
        'attention',
        'listening',
        'thinking',
        'speaking',
        'happy',
        'sad',
        'success',
        'error',
        'reaction',
      ]),
    })
    .strict(),
  VALIDATE: z.object({}).strict(),
  EXPORT: z.object({ includeEditableSource: z.boolean().default(true) }).strict(),
} satisfies Record<JobAction, z.ZodTypeAny>

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function requireActor(actor: Actor) {
  if (
    !actor.id.trim() ||
    (actor.type === 'AGENT' ? actor.role !== 'AGENT' : actor.role !== 'PLATFORM_ADMIN')
  )
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'A verified human administrator or machine agent actor is required.',
    )
}

function requesterJob(job: Prisma.CharacterFactoryJobGetPayload<object>) {
  return {
    id: job.id,
    tenantId: job.tenantId,
    venueId: job.venueId,
    requestId: job.requestId,
    action: job.action,
    status: job.status,
    customCharacterId: job.customCharacterId,
    baseVersion: job.baseVersion,
    baseRevision: job.baseRevision,
    resultVersion: job.resultVersion,
    resultRevision: job.resultRevision,
    attemptNumber: job.attemptNumber,
    cancelRequested: job.cancelRequestedAt !== null,
    resultPayload: job.resultPayload,
    error: job.errorCode ? { code: job.errorCode } : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  }
}

type BoundedJson = null | boolean | number | string | BoundedJson[] | { [key: string]: BoundedJson }
function boundedJson(value: unknown, depth = 0): BoundedJson {
  if (depth > 8)
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'JSON payload nesting is too deep.',
    )
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 20_000) return value
  if (Array.isArray(value) && value.length <= 500)
    return value.map((item) => boundedJson(item, depth + 1))
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > 500)
      throw new CustomCharacterFactoryActionError(
        'INVALID_INPUT',
        'JSON payload has too many fields.',
      )
    return Object.fromEntries(
      entries.map(([key, item]) => {
        if (!key || key.length > 200)
          throw new CustomCharacterFactoryActionError(
            'INVALID_INPUT',
            'JSON payload field name is invalid.',
          )
        return [key, boundedJson(item, depth + 1)]
      }),
    )
  }
  throw new CustomCharacterFactoryActionError(
    'INVALID_INPUT',
    'Payload must contain bounded JSON values only.',
  )
}

function requireCharacterSpec(value: unknown): CharacterSpec {
  const spec = value as Partial<CharacterSpec>
  const allowed = new Set([
    'schemaVersion',
    'characterId',
    'version',
    'revision',
    'displayName',
    'rigFamily',
    'rigCapabilities',
    'source',
    'masterReference',
    'protectedTraits',
    'slotMap',
    'supportedStates',
    'status',
  ])
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    spec.schemaVersion !== 1 ||
    typeof spec.characterId !== 'string' ||
    !spec.characterId ||
    spec.characterId.length > 191 ||
    !Number.isInteger(spec.version) ||
    Number(spec.version) < 1 ||
    !Number.isInteger(spec.revision) ||
    Number(spec.revision) < 1 ||
    typeof spec.displayName !== 'string' ||
    !spec.displayName.trim() ||
    spec.displayName.length > 120 ||
    typeof spec.rigFamily !== 'string' ||
    !resolveRig(spec as CharacterSpec) ||
    !Array.isArray(spec.protectedTraits) ||
    spec.protectedTraits.length > 40 ||
    !spec.protectedTraits.every(
      (item) => typeof item === 'string' && item.length >= 1 && item.length <= 200,
    ) ||
    !spec.slotMap ||
    typeof spec.slotMap !== 'object' ||
    Object.keys(spec.slotMap).length > 32 ||
    Object.entries(spec.slotMap).some(
      ([key, item]) =>
        !/^[a-z][a-zA-Z0-9]{0,63}$/u.test(key) ||
        typeof item !== 'string' ||
        !item ||
        item.length > 500,
    ) ||
    !Array.isArray(spec.supportedStates) ||
    spec.supportedStates.length !== FACTORY_STATES.length ||
    new Set(spec.supportedStates).size !== FACTORY_STATES.length ||
    !FACTORY_STATES.every((state) => spec.supportedStates?.includes(state)) ||
    !['requested', 'generating', 'candidate', 'invalid', 'exported', 'active', 'archived'].includes(
      String(spec.status),
    ) ||
    !spec.source ||
    typeof spec.masterReference !== 'string'
  )
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'Character result schema or rig capabilities are invalid.',
    )
  const source = sanitizeImportedSource(spec.source)
  if (stable(boundedJson(value)).length > 100_000)
    throw new CustomCharacterFactoryActionError('INVALID_INPUT', 'Character result is too large.')
  return { ...(spec as CharacterSpec), source }
}

function requireVerifiedArtifactReference(value: unknown, expectedSpec: CharacterSpec) {
  const parsed = verifiedArtifactReferenceSchema.safeParse(value)
  if (
    !parsed.success ||
    parsed.data.characterId !== expectedSpec.characterId ||
    parsed.data.characterVersion !== expectedSpec.version
  )
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'Verified artifact reference does not match the completed character identity and version.',
    )
  return parsed.data
}

export async function readCharacterFactoryJobAction(
  input: { tenantId: string; venueId: string; requestId: string },
  client: Pick<typeof db, 'characterFactoryJob'> = db,
) {
  const job = await client.characterFactoryJob.findFirst({
    where: { tenantId: input.tenantId, venueId: input.venueId, requestId: input.requestId },
  })
  if (!job)
    throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Character factory job not found.')
  return requesterJob(job)
}

export async function prepareCharacterFactoryJobAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    action: JobAction
    requestPayload: unknown
    characterId?: string
    baseVersion?: number
    baseRevision?: number
    actor: Actor
  },
  client: Client = db,
) {
  requireActor(input.actor)
  const requestPayload = requestPayloadByAction[input.action].parse(input.requestPayload)
  const requestFingerprint = fingerprint({
    tenantId: input.tenantId,
    venueId: input.venueId,
    characterId: input.characterId ?? null,
    baseVersion: input.baseVersion ?? null,
    baseRevision: input.baseRevision ?? null,
    action: input.action,
    payload: requestPayload,
  })
  const replay = async () => {
    const existing = await client.characterFactoryJob.findFirst({
      where: { tenantId: input.tenantId, requestId: input.requestId },
    })
    if (
      !existing ||
      existing.venueId !== input.venueId ||
      existing.requestFingerprint !== requestFingerprint
    )
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Request ID is already bound to another character factory action.',
      )
    return { job: requesterJob(existing), replayed: true as const }
  }
  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.characterFactoryJob.findFirst({
        where: { tenantId: input.tenantId, requestId: input.requestId },
      })
      if (existing) {
        if (
          existing.venueId !== input.venueId ||
          existing.requestFingerprint !== requestFingerprint
        )
          throw new CustomCharacterFactoryActionError(
            'CONFLICT',
            'Request ID is already bound to another character factory action.',
          )
        return { job: requesterJob(existing), replayed: true as const }
      }
      const venue = await tx.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Venue not found.')
      if (input.characterId) {
        const character = await tx.customCharacter.findFirst({
          where: { id: input.characterId, tenantId: input.tenantId, venueId: input.venueId },
          select: { version: true, revision: true },
        })
        if (!character)
          throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Custom character not found.')
        if (
          (input.baseVersion !== undefined && character.version !== input.baseVersion) ||
          (input.baseRevision !== undefined && character.revision !== input.baseRevision)
        )
          throw new CustomCharacterFactoryActionError(
            'CONFLICT',
            'Custom character changed; refresh and retry.',
          )
      }
      const job = await tx.characterFactoryJob.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          requestId: input.requestId,
          requestFingerprint,
          action: input.action,
          requestPayload: requestPayload as Prisma.InputJsonValue,
          createdBy: input.actor.id,
          ...(input.characterId === undefined ? {} : { customCharacterId: input.characterId }),
          ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
          ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          actorType: input.actor.type ?? 'HUMAN',
          idempotencyKey: input.requestId,
          action: 'character-factory.job-prepared',
          targetType: 'CharacterFactoryJob',
          targetId: job.id,
          afterState: {
            venueId: input.venueId,
            action: input.action,
            status: job.status,
            requestFingerprint,
          },
        },
        tx,
      )
      return { job: requesterJob(job), replayed: false as const }
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
      return replay()
    throw error
  }
}

export async function claimCharacterFactoryJobAction(
  input: { tenantId: string; venueId: string; requestId: string; now?: Date },
  client: Client = db,
) {
  const now = input.now ?? new Date()
  const leaseToken = randomUUID()
  return client.$transaction(async (tx) => {
    await tx.characterFactoryJob.updateMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        status: 'RUNNING',
        leaseExpiresAt: { lte: now },
        cancelRequestedAt: null,
      },
      data: { status: 'QUEUED', leaseToken: null, leaseExpiresAt: null },
    })
    const changed = await tx.characterFactoryJob.updateMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        status: 'QUEUED',
        cancelRequestedAt: null,
      },
      data: {
        status: 'RUNNING',
        attemptNumber: { increment: 1 },
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + CHARACTER_FACTORY_JOB_LEASE_MS),
        claimedAt: now,
      },
    })
    const job = await tx.characterFactoryJob.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, requestId: input.requestId },
    })
    if (!job)
      throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Character factory job not found.')
    return changed.count === 1
      ? { state: 'claimed' as const, job }
      : { state: 'not-claimed' as const, job: requesterJob(job) }
  })
}

export async function heartbeatCharacterFactoryJobAction(
  input: { tenantId: string; venueId: string; requestId: string; leaseToken: string; now?: Date },
  client: Pick<typeof db, 'characterFactoryJob'> = db,
) {
  const now = input.now ?? new Date()
  const changed = await client.characterFactoryJob.updateMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      requestId: input.requestId,
      status: 'RUNNING',
      leaseToken: input.leaseToken,
      leaseExpiresAt: { gt: now },
      cancelRequestedAt: null,
    },
    data: { leaseExpiresAt: new Date(now.getTime() + CHARACTER_FACTORY_JOB_LEASE_MS) },
  })
  if (changed.count !== 1)
    throw new CustomCharacterFactoryActionError(
      'CONFLICT',
      'Character factory job lease is invalid or cancellation was requested.',
    )
}

export async function cancelCharacterFactoryJobAction(
  input: { tenantId: string; venueId: string; requestId: string; actor: Actor; now?: Date },
  client: Client = db,
) {
  requireActor(input.actor)
  const now = input.now ?? new Date()
  return client.$transaction(async (tx) => {
    const job = await tx.characterFactoryJob.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, requestId: input.requestId },
    })
    if (!job)
      throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Character factory job not found.')
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.status))
      return { job: requesterJob(job), replayed: true as const }
    const changed = await tx.characterFactoryJob.updateMany({
      where: { id: job.id, status: job.status, cancelRequestedAt: null },
      data: {
        status: 'CANCELLED',
        cancelRequestedAt: now,
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    })
    if (changed.count !== 1)
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Character factory job changed; refresh and retry.',
      )
    const saved = await tx.characterFactoryJob.findUniqueOrThrow({ where: { id: job.id } })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        actorType: input.actor.type ?? 'HUMAN',
        action: 'character-factory.job-cancel-requested',
        targetType: 'CharacterFactoryJob',
        targetId: job.id,
        beforeState: { status: job.status },
        afterState: { status: saved.status, cancelRequested: true },
      },
      tx,
    )
    return { job: requesterJob(saved), replayed: false as const }
  })
}

export async function completeCharacterFactoryJobAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    leaseToken: string
    resultPayload: unknown
    characterSpec?: unknown
    assetStorageReference?: unknown
    actor: Actor
    now?: Date
  },
  client: Client = db,
  options?: {
    verifyArtifact?: (input: {
      tenantId: string
      venueId: string
      reference: unknown
      expectedSpec: ReturnType<typeof requireCharacterSpec>
    }) => Promise<{ reference: Record<string, string | number>; spec: unknown }>
  },
) {
  requireActor(input.actor)
  const resultPayload = boundedJson(input.resultPayload)
  const characterSpec =
    input.characterSpec === undefined ? undefined : requireCharacterSpec(input.characterSpec)
  if (stable(resultPayload).length > 100_000)
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'Character factory result payload is too large.',
    )
  const verifiedArtifact =
    input.assetStorageReference === undefined
      ? undefined
      : options?.verifyArtifact
        ? await options.verifyArtifact({
            tenantId: input.tenantId,
            venueId: input.venueId,
            reference: input.assetStorageReference,
            expectedSpec:
              characterSpec ??
              (() => {
                throw new CustomCharacterFactoryActionError(
                  'INVALID_INPUT',
                  'An artifact requires a character result.',
                )
              })(),
          })
        : (() => {
            throw new CustomCharacterFactoryActionError(
              'INVALID_INPUT',
              'Artifact storage verification is required before completion.',
            )
          })()
  if (verifiedArtifact && stable(verifiedArtifact.spec) !== stable(characterSpec))
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'Verified artifact does not contain the exact completed character specification.',
    )
  const artifactReference = verifiedArtifact
    ? requireVerifiedArtifactReference(verifiedArtifact.reference, characterSpec!)
    : undefined
  // Storage verification is deliberately outside the transaction. Re-evaluate the
  // lease fence afterwards so slow I/O cannot extend an executor's authority.
  const now = input.now ?? new Date()
  return client.$transaction(async (tx) => {
    const job = await tx.characterFactoryJob.findFirst({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        status: 'RUNNING',
        leaseToken: input.leaseToken,
        leaseExpiresAt: { gt: now },
        cancelRequestedAt: null,
      },
    })
    if (!job)
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Character factory job lease is invalid, expired, or cancelled.',
      )
    const mutating =
      job.action === 'CREATE_FROM_IMPORT' || job.action === 'REVISE' || job.action === 'EXPORT'
    if (mutating !== Boolean(characterSpec))
      throw new CustomCharacterFactoryActionError(
        'INVALID_INPUT',
        mutating
          ? 'This job requires a character result.'
          : 'This job action cannot mutate a character.',
      )
    if (characterSpec) {
      if (job.action === 'CREATE_FROM_IMPORT') {
        const frozen = job.requestPayload as {
          characterId?: unknown
          sourceAssetReference?: unknown
          sourceSha256?: unknown
        }
        if (
          characterSpec.characterId !== frozen.characterId ||
          characterSpec.masterReference !== frozen.sourceAssetReference ||
          characterSpec.source.sha256 !== frozen.sourceSha256 ||
          characterSpec.version !== 1 ||
          characterSpec.revision !== 1 ||
          !['candidate', 'invalid'].includes(characterSpec.status) ||
          !artifactReference
        )
          throw new CustomCharacterFactoryActionError(
            'INVALID_INPUT',
            'Created characters must begin at version 1 and revision 1.',
          )
        await tx.customCharacter.create({
          data: {
            id: characterSpec.characterId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            displayName: characterSpec.displayName,
            status: databaseStatus(characterSpec),
            capabilityMetadata: metadata(characterSpec),
            fallbackBehavior: {
              mode: 'static-or-hidden',
              semanticStates: [...characterSpec.supportedStates],
            },
            version: 1,
            revision: 1,
            createdBy: job.createdBy,
            updatedBy: job.createdBy,
            ...(artifactReference === undefined
              ? {}
              : {
                  assetStorageReference: JSON.parse(
                    JSON.stringify(artifactReference),
                  ) as Prisma.InputJsonValue,
                }),
          },
        })
      } else {
        if (
          !job.customCharacterId ||
          !['REVISE', 'EXPORT'].includes(job.action) ||
          job.baseRevision === null ||
          characterSpec.characterId !== job.customCharacterId ||
          characterSpec.revision !== job.baseRevision + 1
        )
          throw new CustomCharacterFactoryActionError(
            'INVALID_INPUT',
            'Character result does not match the frozen job revision.',
          )
        const before = await tx.customCharacter.findFirst({
          where: { id: job.customCharacterId, tenantId: input.tenantId, venueId: input.venueId },
          select: { capabilityMetadata: true },
        })
        if (!before)
          throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Custom character not found.')
        const prior = parseSpec(before.capabilityMetadata)
        if (
          characterSpec.source.sha256 !== prior.source.sha256 ||
          characterSpec.source.sourceUrl !== prior.source.sourceUrl ||
          characterSpec.masterReference !== prior.masterReference ||
          characterSpec.rigFamily !== prior.rigFamily
        )
          throw new CustomCharacterFactoryActionError(
            'INVALID_INPUT',
            'Character source identity and rig family cannot change during this action.',
          )
        if (
          job.baseVersion === null ||
          (job.action === 'REVISE' &&
            (characterSpec.version !== job.baseVersion + 1 ||
              characterSpec.status !== 'candidate')) ||
          (job.action === 'EXPORT' &&
            (characterSpec.version !== job.baseVersion ||
              characterSpec.status !== 'exported' ||
              !artifactReference))
        )
          throw new CustomCharacterFactoryActionError(
            'INVALID_INPUT',
            'Character result transition is invalid for this action.',
          )
        const changedCharacter = await tx.customCharacter.updateMany({
          where: {
            id: job.customCharacterId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            revision: job.baseRevision,
            ...(job.baseVersion === null ? {} : { version: job.baseVersion }),
          },
          data: {
            displayName: characterSpec.displayName,
            status: databaseStatus(characterSpec),
            capabilityMetadata: metadata(characterSpec),
            version: characterSpec.version,
            revision: characterSpec.revision,
            updatedBy: job.createdBy,
            ...(artifactReference === undefined
              ? {}
              : {
                  assetStorageReference: JSON.parse(
                    JSON.stringify(artifactReference),
                  ) as Prisma.InputJsonValue,
                }),
          },
        })
        if (changedCharacter.count !== 1)
          throw new CustomCharacterFactoryActionError(
            'CONFLICT',
            'Late character factory result was fenced by a newer revision.',
          )
      }
    }
    const changed = await tx.characterFactoryJob.updateMany({
      where: {
        id: job.id,
        status: 'RUNNING',
        leaseToken: input.leaseToken,
        leaseExpiresAt: { gt: now },
        cancelRequestedAt: null,
      },
      data: {
        status: 'SUCCEEDED',
        resultPayload: resultPayload as Prisma.InputJsonValue,
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        ...(characterSpec
          ? {
              customCharacterId: characterSpec.characterId,
              resultVersion: characterSpec.version,
              resultRevision: characterSpec.revision,
            }
          : {}),
      },
    })
    if (changed.count !== 1)
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Character factory job completion was fenced.',
      )
    const saved = await tx.characterFactoryJob.findUniqueOrThrow({ where: { id: job.id } })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        actorType: input.actor.type ?? 'HUMAN',
        action: 'character-factory.job-completed',
        targetType: 'CharacterFactoryJob',
        targetId: job.id,
        beforeState: { status: job.status },
        afterState: {
          status: saved.status,
          resultVersion: saved.resultVersion,
          resultRevision: saved.resultRevision,
        },
      },
      tx,
    )
    return saved
  })
}

export async function failCharacterFactoryJobAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    leaseToken: string
    errorCode: string
    errorMessage: string
    actor: Actor
    now?: Date
  },
  client: Client = db,
) {
  const now = input.now ?? new Date()
  requireActor(input.actor)
  return client.$transaction(async (tx) => {
    const changed = await tx.characterFactoryJob.updateMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        status: 'RUNNING',
        leaseToken: input.leaseToken,
        leaseExpiresAt: { gt: now },
        cancelRequestedAt: null,
      },
      data: {
        status: 'FAILED',
        errorCode: input.errorCode.slice(0, 100),
        errorMessage: input.errorMessage.slice(0, 1000),
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    })
    if (changed.count !== 1)
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Character factory job failure was fenced.',
      )
    const saved = await tx.characterFactoryJob.findFirstOrThrow({
      where: { tenantId: input.tenantId, venueId: input.venueId, requestId: input.requestId },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        actorType: input.actor.type ?? 'HUMAN',
        action: 'character-factory.job-failed',
        targetType: 'CharacterFactoryJob',
        targetId: saved.id,
        afterState: { status: saved.status, errorCode: saved.errorCode },
      },
      tx,
    )
    return saved
  })
}

const select = {
  id: true,
  tenantId: true,
  venueId: true,
  displayName: true,
  description: true,
  status: true,
  assetStorageReference: true,
  previewStorageReference: true,
  capabilityMetadata: true,
  fallbackBehavior: true,
  version: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const

function databaseStatus(
  spec: CharacterSpec,
): 'REQUESTED' | 'GENERATING' | 'REVIEW' | 'ACTIVE' | 'ARCHIVED' {
  if (spec.status === 'requested') return 'REQUESTED'
  if (spec.status === 'generating') return 'GENERATING'
  if (spec.status === 'active') return 'ACTIVE'
  if (spec.status === 'archived') return 'ARCHIVED'
  return 'REVIEW'
}

function metadata(spec: CharacterSpec): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({ characterFactory: { schemaVersion: 1, spec } }),
  ) as Prisma.InputJsonValue
}

function parseSpec(value: unknown): CharacterSpec {
  const record = value as { characterFactory?: { spec?: CharacterSpec } } | null
  const spec = record?.characterFactory?.spec
  if (!spec || spec.schemaVersion !== 1 || !spec.characterId) {
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'Character factory metadata is missing or invalid.',
    )
  }
  return spec
}

export async function readCustomCharacterFactoryAction(
  scope: { tenantId: string; venueId: string; characterId: string },
  client: Pick<typeof db, 'customCharacter'> = db,
) {
  const row = await client.customCharacter.findFirst({
    where: { id: scope.characterId, tenantId: scope.tenantId, venueId: scope.venueId },
    select,
  })
  if (!row) throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Custom character not found.')
  return { ...row, spec: parseSpec(row.capabilityMetadata) }
}

export async function createCustomCharacterFactoryAction(
  input: {
    tenantId: string
    venueId: string
    actor: Actor
    spec: CharacterSpec
    description?: string
  },
  client: Client = db,
) {
  return client.$transaction(async (tx) => {
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Venue not found.')
    const existing = await tx.customCharacter.findFirst({
      where: { id: input.spec.characterId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (existing)
      throw new CustomCharacterFactoryActionError('CONFLICT', 'Custom character already exists.')
    const created = await tx.customCharacter.create({
      data: {
        id: input.spec.characterId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        displayName: input.spec.displayName,
        ...(input.description === undefined ? {} : { description: input.description }),
        status: databaseStatus(input.spec),
        capabilityMetadata: metadata(input.spec),
        fallbackBehavior: {
          mode: 'static-or-hidden',
          semanticStates: [...input.spec.supportedStates],
        },
        version: input.spec.version,
        revision: input.spec.revision,
        createdBy: input.actor.id,
        updatedBy: input.actor.id,
      },
      select,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        actorType: input.actor.type ?? 'HUMAN',
        action: 'custom-character.factory-created',
        targetType: 'CustomCharacter',
        targetId: created.id,
        afterState: {
          venueId: input.venueId,
          version: created.version,
          revision: created.revision,
          status: created.status,
        },
      },
      tx,
    )
    return { ...created, spec: parseSpec(created.capabilityMetadata) }
  })
}

export async function compareAndSwapCustomCharacterFactoryAction(
  input: {
    tenantId: string
    venueId: string
    characterId: string
    expectedRevision: number
    actor: Actor
    spec: CharacterSpec
    assetStorageReference?: Prisma.InputJsonValue
  },
  client: Client = db,
) {
  if (
    input.spec.characterId !== input.characterId ||
    input.spec.revision !== input.expectedRevision + 1
  ) {
    throw new CustomCharacterFactoryActionError(
      'INVALID_INPUT',
      'Character identity or next revision is invalid.',
    )
  }
  return client.$transaction(async (tx) => {
    const before = await tx.customCharacter.findFirst({
      where: { id: input.characterId, tenantId: input.tenantId, venueId: input.venueId },
      select,
    })
    if (!before)
      throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Custom character not found.')
    const changed = await tx.customCharacter.updateMany({
      where: {
        id: input.characterId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        revision: input.expectedRevision,
      },
      data: {
        displayName: input.spec.displayName,
        status: databaseStatus(input.spec),
        capabilityMetadata: metadata(input.spec),
        version: input.spec.version,
        revision: input.spec.revision,
        updatedBy: input.actor.id,
        ...(input.assetStorageReference === undefined
          ? {}
          : { assetStorageReference: input.assetStorageReference }),
      },
    })
    if (changed.count !== 1)
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Custom character changed; refresh and retry.',
      )
    const saved = await tx.customCharacter.findFirst({
      where: { id: input.characterId, tenantId: input.tenantId, venueId: input.venueId },
      select,
    })
    if (!saved)
      throw new CustomCharacterFactoryActionError(
        'CONFLICT',
        'Custom character update could not be read back.',
      )
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        actorType: input.actor.type ?? 'HUMAN',
        action: 'custom-character.factory-updated',
        targetType: 'CustomCharacter',
        targetId: saved.id,
        beforeState: { version: before.version, revision: before.revision, status: before.status },
        afterState: { version: saved.version, revision: saved.revision, status: saved.status },
      },
      tx,
    )
    return { ...saved, spec: parseSpec(saved.capabilityMetadata) }
  })
}
