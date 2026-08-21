import { z } from 'zod'

import { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type AgentWorkerClient = Pick<typeof db, '$transaction' | 'agentWorker'>

const workerRegistration = z
  .object({
    workerKey: z.string().trim().min(1).max(191),
    runtimeType: z.enum(['HERMES', 'CODEX', 'CLAUDE', 'OPENAI_COMPATIBLE', 'CUSTOM']),
    label: z.string().trim().min(1).max(200),
    protocolVersion: z.string().trim().min(1).max(100),
    softwareVersion: z.string().trim().min(1).max(100),
    capabilities: z.array(z.string().trim().min(1).max(191)).max(100),
    agentRoles: z.array(z.string().trim().min(1).max(191)).max(50),
    modelProvider: z.string().trim().min(1).max(100).optional(),
    modelName: z.string().trim().min(1).max(191).optional(),
    safeHealth: z.record(z.unknown()).default({}),
  })
  .strict()

const forbiddenHealthKey = /(secret|token|password|authorization|cookie|api.?key|credential)/iu

export class AgentWorkerActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'REVOKED',
    message: string,
  ) {
    super(message)
    this.name = 'AgentWorkerActionError'
  }
}

function assertSafeHealth(value: unknown, depth = 0) {
  if (depth > 5)
    throw new AgentWorkerActionError('FORBIDDEN', 'Health metadata is too deeply nested')
  if (Array.isArray(value)) {
    value.forEach((entry) => assertSafeHealth(entry, depth + 1))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenHealthKey.test(key)) {
        throw new AgentWorkerActionError('FORBIDDEN', 'Health metadata contains a forbidden key')
      }
      assertSafeHealth(entry, depth + 1)
    }
  }
}

export async function registerAgentWorkerAction(
  rawInput: z.input<typeof workerRegistration>,
  rawCredential: z.input<typeof VerifiedMcpCredentialScope>,
  options: { now?: Date; leaseSeconds?: number; client?: AgentWorkerClient } = {},
) {
  const input = workerRegistration.parse(rawInput)
  const credential = VerifiedMcpCredentialScope.parse(rawCredential)
  assertSafeHealth(input.safeHealth)
  if ((input.modelProvider === undefined) !== (input.modelName === undefined)) {
    throw new AgentWorkerActionError(
      'CONFLICT',
      'Model provider and name must be supplied together',
    )
  }
  const excess = input.capabilities.filter(
    (capability) => !credential.capabilities.includes(capability as never),
  )
  if (excess.length > 0) {
    throw new AgentWorkerActionError('FORBIDDEN', 'Worker capabilities exceed credential authority')
  }
  const now = options.now ?? new Date()
  const leaseSeconds = Math.min(Math.max(options.leaseSeconds ?? 90, 30), 300)
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000)
  const client = options.client ?? db
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const credentialRecord = await tx.externalAccessCredential.findFirst({
      where: {
        id: credential.credentialId,
        tenantId: credential.tenantId,
        clientId: credential.clientId,
        enabled: true,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, scopeKey: true, createdBy: true, capabilities: true },
    })
    if (!credentialRecord) {
      throw new AgentWorkerActionError('REVOKED', 'Verified credential is no longer active')
    }
    const existing = await tx.agentWorker.findUnique({
      where: { workerKey: input.workerKey },
      select: { id: true, tenantId: true, credentialId: true, status: true },
    })
    if (
      existing &&
      (existing.tenantId !== credential.tenantId ||
        existing.credentialId !== credential.credentialId)
    ) {
      throw new AgentWorkerActionError('CONFLICT', 'Worker key belongs to another authority')
    }
    const data = {
      runtimeType: input.runtimeType,
      label: input.label,
      protocolVersion: input.protocolVersion,
      softwareVersion: input.softwareVersion,
      capabilities: input.capabilities,
      agentRoles: input.agentRoles,
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      ...(input.modelName ? { modelName: input.modelName } : {}),
      safeHealth: input.safeHealth,
      status: 'ONLINE' as const,
      lastHeartbeatAt: now,
      leaseExpiresAt,
      offlineAt: null,
    }
    const worker = existing
      ? await tx.agentWorker.update({
          where: { id: existing.id },
          data,
          select: { id: true, workerKey: true, status: true, leaseExpiresAt: true },
        })
      : await tx.agentWorker.create({
          data: {
            workerKey: input.workerKey,
            tenantId: credential.tenantId,
            clientId: credential.clientId,
            credentialId: credential.credentialId,
            credentialScopeKey: credentialRecord.scopeKey,
            ownerAdminId: credentialRecord.createdBy,
            ...data,
          },
          select: { id: true, workerKey: true, status: true, leaseExpiresAt: true },
        })
    await writeAuditLogStrict(
      {
        tenantId: credential.tenantId,
        actor: {
          type: 'INTEGRATION',
          actorId: input.workerKey,
          role: 'INTEGRATION',
          integrationId: credential.credentialId,
          credentialId: credential.credentialId,
        },
        action: existing ? 'agent-worker.reregistered' : 'agent-worker.registered',
        targetType: 'AgentWorker',
        targetId: worker.id,
        afterState: {
          status: worker.status,
          runtimeType: input.runtimeType,
          protocolVersion: input.protocolVersion,
          capabilities: input.capabilities,
          agentRoles: input.agentRoles,
        },
      },
      tx,
    )
    return { ...worker, replayed: Boolean(existing) }
  })
}

export async function heartbeatAgentWorkerAction(
  input: { workerKey: string; safeHealth?: Record<string, unknown> },
  rawCredential: z.input<typeof VerifiedMcpCredentialScope>,
  options: { now?: Date; leaseSeconds?: number; client?: AgentWorkerClient } = {},
) {
  const credential = VerifiedMcpCredentialScope.parse(rawCredential)
  const safeHealth = input.safeHealth ?? {}
  assertSafeHealth(safeHealth)
  const now = options.now ?? new Date()
  const leaseSeconds = Math.min(Math.max(options.leaseSeconds ?? 90, 30), 300)
  const client = options.client ?? db
  const updated = await client.agentWorker.updateMany({
    where: {
      workerKey: input.workerKey,
      tenantId: credential.tenantId,
      credentialId: credential.credentialId,
      status: { not: 'REVOKED' },
    },
    data: {
      status: 'ONLINE',
      safeHealth,
      lastHeartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
      offlineAt: null,
    },
  })
  if (updated.count !== 1)
    throw new AgentWorkerActionError('NOT_FOUND', 'Worker not found in scope')
  return { workerKey: input.workerKey, status: 'ONLINE' as const }
}

export async function listAgentWorkerHealth(
  input: { clientId: string; now?: Date },
  client: AgentWorkerClient = db,
) {
  const now = input.now ?? new Date()
  await client.agentWorker.updateMany({
    where: {
      clientId: input.clientId,
      status: 'ONLINE',
      leaseExpiresAt: { lte: now },
    },
    data: { status: 'OFFLINE', offlineAt: now },
  })
  return client.agentWorker.findMany({
    where: { clientId: input.clientId, status: { not: 'REVOKED' } },
    orderBy: [{ status: 'asc' }, { lastHeartbeatAt: 'desc' }],
    take: 100,
    select: {
      id: true,
      workerKey: true,
      runtimeType: true,
      label: true,
      protocolVersion: true,
      softwareVersion: true,
      capabilities: true,
      agentRoles: true,
      modelProvider: true,
      modelName: true,
      safeHealth: true,
      status: true,
      lastHeartbeatAt: true,
      leaseExpiresAt: true,
      offlineAt: true,
    },
  })
}
