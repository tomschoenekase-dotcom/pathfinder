import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  AgentWorkflowPortableManifestSchema,
  AgentWorkflowProvenanceSchema,
} from '@pathfinder/contracts/agent-workflow-registry'
import { MachineActorContext } from '@pathfinder/contracts/actor'
import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    manifest: AgentWorkflowPortableManifestSchema,
    portableText: z.string().trim().min(1).max(50_000),
    provenance: AgentWorkflowProvenanceSchema,
    supersedesVersionId: z.string().uuid().optional(),
    actor: z.union([
      z
        .object({
          type: z.literal('HUMAN'),
          id: z.string().min(1).max(191),
          role: z.literal('PLATFORM_ADMIN'),
        })
        .strict(),
      MachineActorContext.superRefine((actor, context) => {
        if (actor.capability !== 'agent-improvements:propose')
          context.addIssue({
            code: 'custom',
            path: ['capability'],
            message: 'Registration requires agent-improvements:propose.',
          })
        if (!actor.idempotencyKey)
          context.addIssue({
            code: 'custom',
            path: ['idempotencyKey'],
            message: 'Registration requires an idempotency key.',
          })
      }),
    ]),
  })
  .strict()

export type RegisterAgentWorkflowVersionInput = z.input<typeof inputSchema>
export class AgentWorkflowRegistryError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'AgentWorkflowRegistryError'
  }
}

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value as Record<string, unknown>)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`
      : (JSON.stringify(value) ?? 'null')
export const agentWorkflowTextHash = (value: string) =>
  createHash('sha256').update(value).digest('hex')
export const agentWorkflowManifestHash = (value: unknown) => agentWorkflowTextHash(canonical(value))
export function isAgentWorkflowArtifactIntact(version: {
  registryKey: string
  version: number
  kind: string
  manifest: unknown
  manifestHash: string
  portableText: string
  contentHash: string
  requiredToolCapabilities: string[]
}) {
  const manifest = AgentWorkflowPortableManifestSchema.safeParse(version.manifest)
  return Boolean(
    manifest.success &&
    manifest.data.registryKey === version.registryKey &&
    manifest.data.version === version.version &&
    manifest.data.kind === version.kind &&
    canonical(manifest.data.requiredTools.map((tool) => tool.capability).sort()) ===
      canonical([...version.requiredToolCapabilities].sort()) &&
    agentWorkflowTextHash(version.portableText) === version.contentHash &&
    agentWorkflowManifestHash(version.manifest) === version.manifestHash,
  )
}
const select = {
  id: true,
  tenantId: true,
  venueId: true,
  registryKey: true,
  version: true,
  kind: true,
  status: true,
  manifest: true,
  manifestHash: true,
  portableText: true,
  contentHash: true,
  provenance: true,
  requiredToolCapabilities: true,
  supersedesVersionId: true,
  createdByType: true,
  createdById: true,
  createdAt: true,
} as const

function replayMatches(
  replay: Awaited<ReturnType<typeof findReplay>>,
  input: z.output<typeof inputSchema>,
  manifestHash: string,
  contentHash: string,
) {
  return Boolean(
    replay &&
    isAgentWorkflowArtifactIntact(replay) &&
    replay.venueId === input.venueId &&
    replay.registryKey === input.manifest.registryKey &&
    replay.version === input.manifest.version &&
    replay.kind === input.manifest.kind &&
    replay.manifestHash === manifestHash &&
    replay.contentHash === contentHash &&
    canonical(replay.provenance) === canonical(input.provenance) &&
    replay.supersedesVersionId === (input.supersedesVersionId ?? null) &&
    replay.createdByType === input.actor.type &&
    replay.createdById === (input.actor.type === 'HUMAN' ? input.actor.id : input.actor.actorId),
  )
}

function findReplay(
  transaction: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  tenantId: string,
  operationId: string,
) {
  return transaction.agentWorkflowVersion.findFirst({ where: { tenantId, operationId }, select })
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

export async function registerAgentWorkflowVersion(
  raw: RegisterAgentWorkflowVersionInput,
  currentCallableCapabilities: ReadonlySet<string>,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success)
    throw new AgentWorkflowRegistryError(
      'INVALID_INPUT',
      parsed.error.issues[0]?.message ?? 'Invalid workflow version',
    )
  const input = parsed.data
  const required = input.manifest.requiredTools.map((tool) => tool.capability).sort()
  const manifestHash = agentWorkflowManifestHash(input.manifest)
  const contentHash = agentWorkflowTextHash(input.portableText)
  const attempt = () =>
    client.$transaction(async (tx) => {
      if (input.actor.type === 'AGENT') {
        const now = new Date()
        const [identity, worker, run] = await Promise.all([
          tx.agentIdentity.findFirst({
            where: {
              id: input.actor.agentIdentityId,
              tenantId: input.tenantId,
              enabled: true,
              accessCapabilities: { has: 'agent-improvements:propose' },
              OR: [
                { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
                { accessScope: 'VENUE', venueId: input.venueId },
              ],
            },
            select: { id: true },
          }),
          tx.agentWorker.findFirst({
            where: {
              id: input.actor.workerId,
              tenantId: input.tenantId,
              credentialId: input.actor.credentialId,
              capabilities: { has: 'agent-improvements:propose' },
              status: 'ONLINE',
              leaseExpiresAt: { gt: now },
              credential: {
                tenantId: input.tenantId,
                enabled: true,
                revokedAt: null,
                capabilities: { has: 'agent-improvements:propose' },
                AND: [
                  { OR: [{ venueId: null }, { venueId: input.venueId }] },
                  { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                ],
              },
            },
            select: { id: true },
          }),
          tx.agentRun.findFirst({
            where: {
              id: input.actor.agentRunId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              agentIdentityId: input.actor.agentIdentityId,
              executionWorkerId: input.actor.workerId,
              status: 'RUNNING',
              executionLeaseExpiresAt: { gt: now },
              requestedOperation: {
                in: ['agent-workflow-version.register', 'operator_task', 'specialist_delegation'],
              },
            },
            select: { id: true },
          }),
        ])
        if (!identity || !worker || !run)
          throw new AgentWorkflowRegistryError(
            'NOT_FOUND',
            'Authorized registration agent identity or live run was not found',
          )
      }
      const replay = await findReplay(tx, input.tenantId, input.operationId)
      if (replay) {
        if (!replayMatches(replay, input, manifestHash, contentHash))
          throw new AgentWorkflowRegistryError(
            'CONFLICT',
            'Registry operation belongs to different content',
          )
        return {
          version: replay,
          replayed: true as const,
          provenanceVerification: 'DECLARED_NOT_VERIFIED' as const,
        }
      }
      const missing = required.filter((capability) => !currentCallableCapabilities.has(capability))
      if (missing.length)
        throw new AgentWorkflowRegistryError(
          'CONFLICT',
          `Required callable tools are unavailable: ${missing.join(', ')}`,
        )
      let predecessor: {
        id: string
        registryKey: string
        version: number
        contentHash: string
        kind: string
      } | null = null
      if (input.manifest.version > 1) {
        if (!input.supersedesVersionId || !input.manifest.rollback)
          throw new AgentWorkflowRegistryError(
            'INVALID_INPUT',
            'Later versions require exact rollback predecessor',
          )
        predecessor = await tx.agentWorkflowVersion.findFirst({
          where: {
            id: input.supersedesVersionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
          },
          select: { id: true, registryKey: true, version: true, contentHash: true, kind: true },
        })
        if (
          !predecessor ||
          predecessor.registryKey !== input.manifest.registryKey ||
          predecessor.kind !== input.manifest.kind ||
          predecessor.version !== input.manifest.version - 1 ||
          predecessor.contentHash !== input.manifest.rollback.contentHash ||
          input.manifest.rollback.registryKey !== predecessor.registryKey ||
          input.manifest.rollback.version !== predecessor.version
        )
          throw new AgentWorkflowRegistryError(
            'CONFLICT',
            'Rollback predecessor does not match the exact prior version',
          )
      } else if (input.supersedesVersionId || input.manifest.rollback)
        throw new AgentWorkflowRegistryError(
          'INVALID_INPUT',
          'First version cannot declare rollback predecessor',
        )
      const created = await tx.agentWorkflowVersion.create({
        data: {
          operationId: input.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          registryKey: input.manifest.registryKey,
          version: input.manifest.version,
          kind: input.manifest.kind,
          manifest: JSON.parse(JSON.stringify(input.manifest)),
          manifestHash,
          portableText: input.portableText,
          contentHash,
          provenance: JSON.parse(JSON.stringify(input.provenance)),
          requiredToolCapabilities: required,
          ...(predecessor ? { supersedesVersionId: predecessor.id } : {}),
          createdByType: input.actor.type,
          createdById: input.actor.type === 'HUMAN' ? input.actor.id : input.actor.actorId,
        },
        select,
      })
      await writeAuditLogStrict(
        input.actor.type === 'HUMAN'
          ? {
              tenantId: input.tenantId,
              actorId: input.actor.id,
              actorRole: 'PLATFORM_ADMIN',
              action: 'agent-workflow-version.registered',
              targetType: 'AgentWorkflowVersion',
              targetId: created.id,
              afterState: {
                venueId: input.venueId,
                registryKey: created.registryKey,
                version: created.version,
                status: created.status,
                contentHash,
                activationGranted: false,
              },
            }
          : {
              tenantId: input.tenantId,
              actor: input.actor,
              action: 'agent-workflow-version.registered',
              targetType: 'AgentWorkflowVersion',
              targetId: created.id,
              afterState: {
                venueId: input.venueId,
                registryKey: created.registryKey,
                version: created.version,
                status: created.status,
                contentHash,
                activationGranted: false,
              },
            },
        tx,
      )
      return {
        version: created,
        replayed: false as const,
        provenanceVerification: 'DECLARED_NOT_VERIFIED' as const,
      }
    })
  try {
    return await attempt()
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const replay = await client.$transaction((tx) =>
      findReplay(tx, input.tenantId, input.operationId),
    )
    if (replayMatches(replay, input, manifestHash, contentHash))
      return {
        version: replay!,
        replayed: true as const,
        provenanceVerification: 'DECLARED_NOT_VERIFIED' as const,
      }
    throw new AgentWorkflowRegistryError(
      'CONFLICT',
      'Registry version changed concurrently; refresh before retrying',
    )
  }
}

export async function readCompatibleAgentWorkflowVersions(
  input: { tenantId: string; venueId: string; registryKeys: string[] },
  currentCallableCapabilities: ReadonlySet<string>,
  client: typeof db = db,
) {
  const scope = z
    .object({
      tenantId: z.string().min(1).max(191),
      venueId: z.string().min(1).max(191),
      registryKeys: z.array(z.string().min(1).max(191)).min(1).max(50),
    })
    .parse(input)
  const rows = (
    await Promise.all(
      [...new Set(scope.registryKeys)].map((registryKey) =>
        client.agentWorkflowVersion.findFirst({
          where: { tenantId: scope.tenantId, venueId: scope.venueId, registryKey },
          orderBy: [{ version: 'desc' }, { id: 'desc' }],
          select,
        }),
      ),
    )
  ).filter((row): row is NonNullable<typeof row> => row !== null)
  const byKey = new Map(rows.map((row) => [row.registryKey, row]))
  return scope.registryKeys.map((registryKey) => {
    const version = byKey.get(registryKey)
    if (!version)
      return {
        registryKey,
        compatibility: 'NOT_FOUND' as const,
        missingCapabilities: [],
        version: null,
      }
    const missingCapabilities = version.requiredToolCapabilities.filter(
      (capability) => !currentCallableCapabilities.has(capability),
    )
    if (!isAgentWorkflowArtifactIntact(version))
      return {
        registryKey,
        compatibility: 'INVALID_ARTIFACT' as const,
        missingCapabilities: [],
        version: null,
      }
    return {
      registryKey,
      compatibility: missingCapabilities.length
        ? ('MISSING_TOOLS' as const)
        : ('COMPATIBLE' as const),
      missingCapabilities,
      version,
      provenanceVerification: 'DECLARED_NOT_VERIFIED' as const,
    }
  })
}
