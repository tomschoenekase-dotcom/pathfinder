import { z } from 'zod'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  claimAgentRunExecution,
  completeAgentRunExecution,
  failAgentRunExecution,
  heartbeatAgentRunExecution,
} from './agent-run-execution-actions'

const providerSchema = z.enum([
  'HERMES',
  'CLAUDE_SUBSCRIPTION',
  'CODEX_SUBSCRIPTION',
  'OPENAI_COMPATIBLE',
])
const providerTarget = {
  HERMES: 'hermes-bridge',
  CLAUDE_SUBSCRIPTION: 'claude-bridge',
  CODEX_SUBSCRIPTION: 'codex-bridge',
  OPENAI_COMPATIBLE: 'openai-compatible-bridge',
} as const
const SESSION_TTL_MS = 2 * 60_000

export class AgentBridgeActionError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'AgentBridgeActionError'
  }
}

function assertCredential(credential: VerifiedMcpCredentialScope, venueId: string) {
  if (
    !credential.venueIds.includes(venueId) ||
    !credential.capabilities.includes('agent-runs:execute')
  ) {
    throw new AgentBridgeActionError(
      'FORBIDDEN',
      'Credential cannot execute agent runs in this venue',
    )
  }
}

export async function registerAgentBridgeSession(rawInput: {
  sessionId: string
  venueId: string
  provider: string
  label: string
  runnerVersion: string
  supportedModels: string[]
  credential: VerifiedMcpCredentialScope
}) {
  const input = z
    .object({
      sessionId: z.string().uuid(),
      venueId: z.string().min(1).max(191),
      provider: providerSchema,
      label: z.string().trim().min(1).max(200),
      runnerVersion: z.string().trim().min(1).max(100),
      supportedModels: z.array(z.string().trim().min(1).max(191)).max(50),
    })
    .parse(rawInput)
  assertCredential(rawInput.credential, input.venueId)
  const credential = rawInput.credential
  const active = await db.externalAccessCredential.findFirst({
    where: {
      id: credential.credentialId,
      tenantId: credential.tenantId,
      clientId: credential.clientId,
      venueId: input.venueId,
      kind: 'MCP',
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      capabilities: { has: 'agent-runs:execute' },
    },
    select: { id: true, scopeKey: true },
  })
  if (!active) throw new AgentBridgeActionError('FORBIDDEN', 'Bridge credential is inactive')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
  const existing = await db.agentBridgeSession.findFirst({
    where: { id: input.sessionId, tenantId: credential.tenantId },
    select: { credentialId: true, venueId: true, provider: true },
  })
  if (
    existing &&
    (existing.credentialId !== credential.credentialId ||
      existing.venueId !== input.venueId ||
      existing.provider !== input.provider)
  ) {
    throw new AgentBridgeActionError(
      'CONFLICT',
      'Bridge session identity is bound to different scope',
    )
  }
  return db.agentBridgeSession.upsert({
    where: {
      id_tenantId: { id: input.sessionId, tenantId: credential.tenantId },
    },
    create: {
      id: input.sessionId,
      tenantId: credential.tenantId,
      clientId: credential.clientId,
      venueId: input.venueId,
      scopeKey: active.scopeKey,
      credentialId: credential.credentialId,
      provider: input.provider,
      label: input.label,
      runnerVersion: input.runnerVersion,
      supportedModels: [...new Set(input.supportedModels)].sort(),
      status: 'ONLINE',
      lastHeartbeatAt: now,
      expiresAt,
    },
    update: {
      label: input.label,
      runnerVersion: input.runnerVersion,
      supportedModels: [...new Set(input.supportedModels)].sort(),
      status: 'ONLINE',
      lastHeartbeatAt: now,
      expiresAt,
    },
    select: {
      id: true,
      provider: true,
      label: true,
      runnerVersion: true,
      supportedModels: true,
      status: true,
      lastHeartbeatAt: true,
      expiresAt: true,
    },
  })
}

export async function heartbeatAgentBridgeSession(input: {
  sessionId: string
  venueId: string
  credential: VerifiedMcpCredentialScope
}) {
  assertCredential(input.credential, input.venueId)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
  const changed = await db.agentBridgeSession.updateMany({
    where: {
      id: input.sessionId,
      tenantId: input.credential.tenantId,
      venueId: input.venueId,
      credentialId: input.credential.credentialId,
      status: { not: 'REVOKED' },
      credential: {
        enabled: true,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        capabilities: { has: 'agent-runs:execute' },
      },
    },
    data: { status: 'ONLINE', lastHeartbeatAt: now, expiresAt },
  })
  if (changed.count !== 1) throw new AgentBridgeActionError('NOT_FOUND', 'Bridge session not found')
  return { status: 'ONLINE' as const, expiresAt }
}

export async function claimAgentBridgeTask(input: {
  sessionId: string
  venueId: string
  credential: VerifiedMcpCredentialScope
}) {
  assertCredential(input.credential, input.venueId)
  const session = await db.agentBridgeSession.findFirst({
    where: {
      id: input.sessionId,
      tenantId: input.credential.tenantId,
      venueId: input.venueId,
      credentialId: input.credential.credentialId,
      status: 'ONLINE',
      expiresAt: { gt: new Date() },
      credential: {
        enabled: true,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        capabilities: { has: 'agent-runs:execute' },
      },
    },
    select: { id: true, provider: true, supportedModels: true },
  })
  if (!session)
    throw new AgentBridgeActionError('FORBIDDEN', 'Bridge session is offline or expired')
  const run = await db.agentRun.findFirst({
    where: {
      tenantId: input.credential.tenantId,
      venueId: input.venueId,
      status: 'QUEUED',
      modelProvider: providerTarget[session.provider],
      ...(session.supportedModels.length
        ? {
            OR: [
              { modelName: { in: session.supportedModels } },
              { modelName: 'subscription-default' },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
  if (!run) return { task: null }
  const claimed = await claimAgentRunExecution({
    tenantId: input.credential.tenantId,
    runId: run.id,
    bridgeSessionId: session.id,
  })
  return {
    task: {
      id: claimed.id,
      venueId: claimed.venueId,
      runType: claimed.runType,
      requestedOperation: claimed.requestedOperation,
      prompt: claimed.requestPrompt,
      modelProvider: claimed.modelProvider,
      modelName: claimed.modelName,
      leaseToken: claimed.leaseToken,
      leaseExpiresAt: claimed.leaseExpiresAt,
      attemptNumber: claimed.attemptNumber,
      scope: claimed.scopeSnapshot,
      agent: claimed.agentIdentity,
    },
  }
}

async function assertSessionOwnsRun(input: {
  sessionId: string
  venueId: string
  runId: string
  credential: VerifiedMcpCredentialScope
}) {
  assertCredential(input.credential, input.venueId)
  const run = await db.agentRun.findFirst({
    where: {
      id: input.runId,
      tenantId: input.credential.tenantId,
      venueId: input.venueId,
      executionBridgeSessionId: input.sessionId,
      executionBridgeSession: {
        credentialId: input.credential.credentialId,
        status: 'ONLINE',
        expiresAt: { gt: new Date() },
        credential: {
          enabled: true,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          capabilities: { has: 'agent-runs:execute' },
        },
      },
    },
    select: { id: true },
  })
  if (!run) throw new AgentBridgeActionError('FORBIDDEN', 'Bridge session does not own this run')
}

export async function heartbeatAgentBridgeTask(input: {
  sessionId: string
  venueId: string
  runId: string
  leaseToken: string
  credential: VerifiedMcpCredentialScope
}) {
  await assertSessionOwnsRun(input)
  return heartbeatAgentRunExecution({
    tenantId: input.credential.tenantId,
    runId: input.runId,
    leaseToken: input.leaseToken,
    leaseDurationMs: 90_000,
  })
}

export async function completeAgentBridgeTask(input: {
  sessionId: string
  venueId: string
  runId: string
  leaseToken: string
  summary: string
  artifacts: unknown[]
  modelName: string
  costE8Usd: bigint
  credential: VerifiedMcpCredentialScope
}) {
  await assertSessionOwnsRun(input)
  return completeAgentRunExecution({
    tenantId: input.credential.tenantId,
    runId: input.runId,
    leaseToken: input.leaseToken,
    summary: input.summary,
    artifacts: input.artifacts as never[],
    modelName: input.modelName,
    costE8Usd: input.costE8Usd,
  })
}

export async function failAgentBridgeTask(input: {
  sessionId: string
  venueId: string
  runId: string
  leaseToken: string
  errorCode: string
  errorMessage: string
  retryable: boolean
  credential: VerifiedMcpCredentialScope
}) {
  await assertSessionOwnsRun(input)
  return failAgentRunExecution({
    tenantId: input.credential.tenantId,
    runId: input.runId,
    leaseToken: input.leaseToken,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    retryable: input.retryable,
  })
}

export async function revokeAgentBridgeSessionAction(input: {
  tenantId: string
  venueId: string
  sessionId: string
  reason: string
  actor: { id: string; role: 'PLATFORM_ADMIN' }
}) {
  const parsed = z
    .object({
      tenantId: z.string().trim().min(1).max(191),
      venueId: z.string().trim().min(1).max(191),
      sessionId: z.string().uuid(),
      reason: z.string().trim().min(1).max(500),
      actor: z.object({ id: z.string().trim().min(1).max(191), role: z.literal('PLATFORM_ADMIN') }),
    })
    .parse(input)
  return db.$transaction(async (transaction) => {
    const session = await transaction.agentBridgeSession.findFirst({
      where: { id: parsed.sessionId, tenantId: parsed.tenantId, venueId: parsed.venueId },
      select: { id: true, status: true, provider: true, label: true },
    })
    if (!session) throw new AgentBridgeActionError('NOT_FOUND', 'Bridge session not found')
    if (session.status === 'REVOKED') return { ...session, replayed: true }
    const changed = await transaction.agentBridgeSession.updateMany({
      where: {
        id: session.id,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        status: session.status,
      },
      data: { status: 'REVOKED', expiresAt: new Date() },
    })
    if (changed.count !== 1)
      throw new AgentBridgeActionError(
        'CONFLICT',
        'Bridge session changed; refresh before retrying',
      )
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        actorId: parsed.actor.id,
        actorRole: parsed.actor.role,
        action: 'admin.agent-bridge.revoked',
        targetType: 'AgentBridgeSession',
        targetId: session.id,
        beforeState: { status: session.status, provider: session.provider, label: session.label },
        afterState: { status: 'REVOKED', reason: parsed.reason },
      },
      transaction,
    )
    return { ...session, status: 'REVOKED' as const, replayed: false }
  })
}
