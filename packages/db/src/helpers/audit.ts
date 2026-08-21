import { logger } from '@pathfinder/config/logger'
import type { VerifiedActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'

type AuditEvidence = {
  tenantId?: string | null
  agentIdentityId?: string
  agentRunId?: string
  workerId?: string
  systemJobId?: string
  integrationId?: string
  credentialId?: string
  approvalGrantId?: string
  capability?: string
  modelProvider?: string
  modelName?: string
  idempotencyKey?: string
  structuredReason?: Record<string, unknown>
  sourceReferences?: unknown[]
  action: string
  targetType: string
  targetId: string
  beforeState?: Record<string, unknown>
  afterState?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
  createdAt?: Date
}

export type WriteAuditLogParams = AuditEvidence &
  (
    | {
        actor: VerifiedActorContext
        actorId?: never
        actorRole?: never
        actorType?: never
      }
    | {
        actor?: never
        actorId: string
        actorRole: string
        actorType?: VerifiedActorContext['type']
      }
  )

function auditLogData(params: WriteAuditLogParams) {
  const actor = params.actor
  const resolvedActorId = actor ? actor.actorId : params.actorId
  const resolvedActorRole = actor ? actor.role : params.actorRole
  const data = {
    actorType: actor?.type ?? params.actorType ?? 'HUMAN',
    actorId: resolvedActorId,
    actorRole: resolvedActorRole,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
  }

  if (params.tenantId !== undefined) Object.assign(data, { tenantId: params.tenantId })
  const optionalLineage = {
    agentIdentityId: actor?.agentIdentityId ?? params.agentIdentityId,
    agentRunId: actor?.agentRunId ?? params.agentRunId,
    workerId: actor?.workerId ?? params.workerId,
    systemJobId: actor?.systemJobId ?? params.systemJobId,
    integrationId: actor?.integrationId ?? params.integrationId,
    credentialId: actor?.credentialId ?? params.credentialId,
    approvalGrantId: actor?.approvalGrantId ?? params.approvalGrantId,
    capability: actor?.capability ?? params.capability,
    modelProvider: actor?.modelProvider ?? params.modelProvider,
    modelName: actor?.modelName ?? params.modelName,
    idempotencyKey: actor?.idempotencyKey ?? params.idempotencyKey,
  }
  for (const [key, value] of Object.entries(optionalLineage)) {
    if (value !== undefined) Object.assign(data, { [key]: value })
  }
  if (params.structuredReason !== undefined)
    Object.assign(data, { structuredReason: params.structuredReason })
  if (params.sourceReferences !== undefined)
    Object.assign(data, { sourceReferences: params.sourceReferences })
  if (params.beforeState !== undefined) Object.assign(data, { beforeState: params.beforeState })
  if (params.afterState !== undefined) Object.assign(data, { afterState: params.afterState })
  if (params.ipAddress !== undefined) Object.assign(data, { ipAddress: params.ipAddress })
  if (params.userAgent !== undefined) Object.assign(data, { userAgent: params.userAgent })
  if (params.createdAt !== undefined) Object.assign(data, { createdAt: params.createdAt })
  return data
}

type AuditLogClient = Pick<typeof db, 'auditLog'>

export async function writeAuditLogStrict(
  params: WriteAuditLogParams,
  client: AuditLogClient = db,
): Promise<void> {
  await client.auditLog.create({ data: auditLogData(params) })
}

export async function writeAuditLog(params: WriteAuditLogParams): Promise<void> {
  try {
    await writeAuditLogStrict(params)
  } catch (error) {
    const logFields = {
      service: '@pathfinder/db',
      action: 'audit-log.write-failed',
      actorId: params.actor?.actorId ?? params.actorId,
      targetType: params.targetType,
      targetId: params.targetId,
      error: error instanceof Error ? error.message : 'Unknown audit log write error',
    }

    if (params.tenantId !== undefined) {
      Object.assign(logFields, { tenantId: params.tenantId })
    }

    logger.warn(logFields)
  }
}
