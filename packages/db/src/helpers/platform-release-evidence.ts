import { createHash } from 'node:crypto'

import { ReleaseEvidenceRecordFields } from '@pathfinder/contracts/release-evidence'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const actor = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('HUMAN'),
      id: z.string().trim().min(1).max(191),
      role: z.literal('PLATFORM_ADMIN'),
    })
    .strict(),
  z
    .object({
      type: z.literal('AGENT'),
      id: z.string().trim().min(1).max(191),
      credentialId: z.string().trim().min(1).max(191),
      capability: z.literal('release-evidence:record'),
    })
    .strict(),
])

const inputSchema = ReleaseEvidenceRecordFields.extend({ actor })
  .strict()
  .superRefine((value, context) => {
    if (
      value.stagingHandoff?.status === 'ready-for-owner-staging-integration' &&
      value.assessment.readiness !== 'ready-for-staging-review'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['stagingHandoff', 'status'],
        message: 'A staging-ready handoff requires a staging-review-ready assessment.',
      })
    }
  })
type Input = z.output<typeof inputSchema>

export type PlatformReleaseEvidenceClient = Pick<typeof db, '$transaction'>
type Transaction = Pick<
  typeof db,
  'platformReleaseEvidence' | 'platformWorkerPolicyCredential' | 'auditLog'
>

export class PlatformReleaseEvidenceError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'IDEMPOTENCY_CONFLICT' | 'INACTIVE_CREDENTIAL' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'PlatformReleaseEvidenceError'
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const isUniqueConflict = (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')

const select = {
  id: true,
  operationId: true,
  operationHash: true,
  evidenceHash: true,
  revision: true,
  profile: true,
  readiness: true,
  assessmentGeneratedAt: true,
  repositoryClean: true,
  passed: true,
  failed: true,
  blocked: true,
  gates: true,
  limitations: true,
  rollback: true,
  stagingHandoff: true,
  sourceReference: true,
  recordedByType: true,
  recordedById: true,
  credentialId: true,
  createdAt: true,
} as const

function hashes(input: Input) {
  const evidence = {
    assessment: input.assessment,
    stagingHandoff: input.stagingHandoff,
    sourceReference: input.sourceReference,
  }
  return {
    evidenceHash: hash(evidence),
    operationHash: hash({
      action: 'platform-release-evidence.record.v1',
      operationId: input.operationId,
      evidence,
      actor: input.actor,
    }),
  }
}

async function findExisting(transaction: Transaction, input: Input) {
  const expected = hashes(input)
  const byOperation = await transaction.platformReleaseEvidence.findUnique({
    where: { operationId: input.operationId },
    select,
  })
  if (byOperation) {
    if (byOperation.operationHash !== expected.operationHash) {
      throw new PlatformReleaseEvidenceError(
        'IDEMPOTENCY_CONFLICT',
        'The operation ID was already used for different release evidence.',
      )
    }
    return { ...byOperation, replayed: true as const, deduplicated: false as const }
  }
  const byEvidence = await transaction.platformReleaseEvidence.findUnique({
    where: { evidenceHash: expected.evidenceHash },
    select,
  })
  return byEvidence ? { ...byEvidence, replayed: true as const, deduplicated: true as const } : null
}

/**
 * Records immutable release evidence only. It grants no staging or production deployment,
 * migration, customer-contact, billing, pricing, or destructive-data authority.
 */
export async function recordPlatformReleaseEvidenceAction(
  rawInput: unknown,
  client: PlatformReleaseEvidenceClient = db,
) {
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new PlatformReleaseEvidenceError('INVALID_INPUT', 'Release evidence is invalid.')
  }
  const input = parsed.data
  const expected = hashes(input)

  const attempt = () =>
    client.$transaction(async (transaction) => {
      const replay = await findExisting(transaction, input)
      if (replay) return replay

      if (input.actor.type === 'AGENT') {
        const credential = await transaction.platformWorkerPolicyCredential.findFirst({
          where: {
            id: input.actor.credentialId,
            workerId: input.actor.id,
            enabled: true,
            revokedAt: null,
            capabilities: { has: 'release-evidence:record' },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { id: true },
        })
        if (!credential) {
          throw new PlatformReleaseEvidenceError(
            'INACTIVE_CREDENTIAL',
            'An active release-evidence:record credential is required.',
          )
        }
      }

      const created = await transaction.platformReleaseEvidence.create({
        data: {
          operationId: input.operationId,
          operationHash: expected.operationHash,
          evidenceHash: expected.evidenceHash,
          revision: input.assessment.revision,
          profile: input.assessment.profile,
          readiness: input.assessment.readiness,
          assessmentGeneratedAt: new Date(input.assessment.generatedAt),
          repositoryClean: input.assessment.repository.clean,
          passed: input.assessment.summary.passed,
          failed: input.assessment.summary.failed,
          blocked: input.assessment.summary.blocked,
          gates: input.assessment.gates,
          limitations: input.assessment.limitations,
          rollback: input.assessment.rollback,
          stagingHandoff: input.stagingHandoff ?? Prisma.DbNull,
          sourceReference: input.sourceReference,
          recordedByType: input.actor.type,
          recordedById: input.actor.id,
          credentialId: input.actor.type === 'AGENT' ? input.actor.credentialId : null,
        },
        select,
      })

      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.type === 'HUMAN' ? input.actor.role : 'PLATFORM_POLICY_WORKER',
          actorType: input.actor.type,
          ...(input.actor.type === 'AGENT' ? { credentialId: input.actor.credentialId } : {}),
          capability:
            input.actor.type === 'AGENT' ? input.actor.capability : 'release-evidence:record',
          action: 'platform-release-evidence.recorded',
          targetType: 'PlatformReleaseEvidence',
          targetId: created.id,
          structuredReason: { effect: 'EVIDENCE_ONLY', scope: 'PLATFORM' },
          afterState: {
            revision: created.revision,
            profile: created.profile,
            readiness: created.readiness,
            passed: created.passed,
            failed: created.failed,
            blocked: created.blocked,
            evidenceHash: created.evidenceHash,
            stagingHandoffStatus: input.stagingHandoff?.status ?? null,
            deploysApplication: false,
            runsMigration: false,
            authorizesProduction: false,
            contactsCustomer: false,
            changesBilling: false,
          },
        },
        transaction,
      )
      return { ...created, replayed: false as const, deduplicated: false as const }
    })

  try {
    return await attempt()
  } catch (error) {
    if (error instanceof PlatformReleaseEvidenceError || !isUniqueConflict(error)) throw error
    return client.$transaction(async (transaction) => {
      const replay = await findExisting(transaction, input)
      if (replay) return replay
      throw new PlatformReleaseEvidenceError(
        'CONFLICT',
        'Release evidence changed concurrently; retry with the same operation identity.',
      )
    })
  }
}

export async function readPlatformReleaseEvidence(
  limit = 5,
  client: Pick<typeof db, 'platformReleaseEvidence'> = db,
) {
  const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)))
  const items = await client.platformReleaseEvidence.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: boundedLimit,
    select,
  })
  return {
    schemaVersion: 'torchiko.platform-release-evidence.v1' as const,
    generatedAt: new Date(),
    current: items[0] ?? null,
    items,
    boundaries: {
      evidenceOnly: true as const,
      stagingDeploymentAuthorized: false as const,
      productionDeploymentAuthorized: false as const,
      productionMigrationAuthorized: false as const,
      customerContactAuthorized: false as const,
      liveBillingAuthorized: false as const,
      valuableDataDestructionAuthorized: false as const,
    },
  }
}
