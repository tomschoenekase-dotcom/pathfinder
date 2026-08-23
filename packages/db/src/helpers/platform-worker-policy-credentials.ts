import { createHash, randomBytes } from 'node:crypto'
import { argon2Verify, argon2id } from 'hash-wasm'
import { z } from 'zod'

import {
  PlatformWorkerPolicyCapability,
  VerifiedPlatformWorkerPolicyCredential,
} from '@pathfinder/contracts/platform-worker-policy'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const actor = z
  .object({
    type: z.literal('HUMAN'),
    id: z.string().trim().min(1).max(191),
    role: z.literal('PLATFORM_ADMIN'),
  })
  .strict()
const credentialSelect = {
  id: true,
  workerId: true,
  label: true,
  capabilities: true,
  secretPrefix: true,
  hashAlgorithm: true,
  enabled: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdBy: true,
  activatedBy: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

export type PlatformWorkerPolicyCredentialClient = Pick<
  typeof db,
  '$transaction' | 'platformWorkerPolicyCredential'
>

export class PlatformWorkerPolicyCredentialError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'INACTIVE') {
    super(code === 'INACTIVE' ? 'Platform worker policy credential is invalid or inactive' : code)
    this.name = 'PlatformWorkerPolicyCredentialError'
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const conflict = () => new PlatformWorkerPolicyCredentialError('CONFLICT')
const uniqueOrConflict = (error: unknown): never => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
    throw conflict()
  throw error
}

export async function issuePlatformWorkerPolicyCredentialAction(
  raw: unknown,
  client: PlatformWorkerPolicyCredentialClient = db,
) {
  const parsed = z
    .object({
      operationId: z.string().uuid(),
      workerId: z.string().trim().min(1).max(191),
      label: z.string().trim().min(1).max(200),
      capabilities: z
        .array(PlatformWorkerPolicyCapability)
        .min(1)
        .max(PlatformWorkerPolicyCapability.options.length),
      expiresAt: z.date().nullable(),
      actor,
    })
    .strict()
    .safeParse(raw)
  if (!parsed.success) throw new PlatformWorkerPolicyCredentialError('INVALID_INPUT')
  const input = parsed.data
  const capabilities = [...new Set(input.capabilities)].sort()
  if (capabilities.length !== input.capabilities.length)
    throw new PlatformWorkerPolicyCredentialError('INVALID_INPUT')
  const operationHash = hash({
    action: 'ISSUE',
    operationId: input.operationId,
    workerId: input.workerId,
    label: input.label,
    capabilities,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    actorId: input.actor.id,
  })
  const prior = await client.platformWorkerPolicyCredential.findUnique({
    where: { issueOperationId: input.operationId },
    select: { issueOperationHash: true, ...credentialSelect },
  })
  if (prior) {
    if (prior.issueOperationHash !== operationHash) throw conflict()
    const { issueOperationHash: _, ...credential } = prior
    void _
    return { credential, plaintextSecret: null, replayed: true as const }
  }
  const plaintextSecret = `pf_platform_${randomBytes(32).toString('base64url')}`
  const secretPrefix = plaintextSecret.slice(0, 24)
  const secretHash = await argon2id({
    password: plaintextSecret,
    salt: randomBytes(16),
    memorySize: 19_456,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
    outputType: 'encoded',
  })
  try {
    const credential = await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const created = await tx.platformWorkerPolicyCredential.create({
        data: {
          issueOperationId: input.operationId,
          issueOperationHash: operationHash,
          workerId: input.workerId,
          label: input.label,
          capabilities,
          secretPrefix,
          secretHash,
          enabled: false,
          expiresAt: input.expiresAt,
          createdBy: input.actor.id,
        },
        select: credentialSelect,
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: 'PLATFORM_ADMIN',
          action: 'platform-worker-policy-credential.issued-disabled',
          targetType: 'PlatformWorkerPolicyCredential',
          targetId: created.id,
          afterState: { workerId: input.workerId, capabilities, enabled: false },
        },
        tx,
      )
      return created
    })
    return { credential, plaintextSecret, replayed: false as const }
  } catch (error) {
    const converged = await client.platformWorkerPolicyCredential.findUnique({
      where: { issueOperationId: input.operationId },
      select: { issueOperationHash: true, ...credentialSelect },
    })
    if (converged?.issueOperationHash === operationHash) {
      const { issueOperationHash: _, ...credential } = converged
      void _
      return { credential, plaintextSecret: null, replayed: true as const }
    }
    return uniqueOrConflict(error)
  }
}

const lifecycle = z
  .object({
    operationId: z.string().uuid(),
    credentialId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.date(),
    actor,
  })
  .strict()

export async function activatePlatformWorkerPolicyCredentialAction(
  raw: unknown,
  client: PlatformWorkerPolicyCredentialClient = db,
) {
  const parsed = lifecycle.safeParse(raw)
  if (!parsed.success) throw new PlatformWorkerPolicyCredentialError('INVALID_INPUT')
  const input = parsed.data
  const operationHash = hash({
    action: 'ACTIVATE',
    operationId: input.operationId,
    credentialId: input.credentialId,
    expectedUpdatedAt: input.expectedUpdatedAt.toISOString(),
    actorId: input.actor.id,
  })
  const replay = await client.platformWorkerPolicyCredential.findUnique({
    where: { activationOperationId: input.operationId },
    select: { activationHash: true, ...credentialSelect },
  })
  if (replay) {
    if (replay.activationHash !== operationHash) throw conflict()
    const { activationHash: _, ...credential } = replay
    void _
    return { credential, replayed: true as const }
  }
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const current = await tx.platformWorkerPolicyCredential.findFirst({
        where: {
          id: input.credentialId,
          enabled: false,
          revokedAt: null,
          activatedAt: null,
          updatedAt: input.expectedUpdatedAt,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: credentialSelect,
      })
      if (!current) throw conflict()
      const now = new Date()
      const changed = await tx.platformWorkerPolicyCredential.updateMany({
        where: {
          id: current.id,
          enabled: false,
          revokedAt: null,
          activatedAt: null,
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          enabled: true,
          activatedBy: input.actor.id,
          activatedAt: now,
          activationOperationId: input.operationId,
          activationHash: operationHash,
        },
      })
      if (changed.count !== 1) throw conflict()
      const credential = await tx.platformWorkerPolicyCredential.findUniqueOrThrow({
        where: { id: current.id },
        select: credentialSelect,
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: 'PLATFORM_ADMIN',
          action: 'platform-worker-policy-credential.activated',
          targetType: 'PlatformWorkerPolicyCredential',
          targetId: current.id,
          beforeState: { enabled: false },
          afterState: {
            workerId: current.workerId,
            capabilities: current.capabilities,
            enabled: true,
          },
        },
        tx,
      )
      return { credential, replayed: false as const }
    })
  } catch (error) {
    const converged = await client.platformWorkerPolicyCredential.findUnique({
      where: { activationOperationId: input.operationId },
      select: { activationHash: true, ...credentialSelect },
    })
    if (converged?.activationHash === operationHash) {
      const { activationHash: _, ...credential } = converged
      void _
      return { credential, replayed: true as const }
    }
    return uniqueOrConflict(error)
  }
}

export async function revokePlatformWorkerPolicyCredentialAction(
  raw: unknown,
  client: PlatformWorkerPolicyCredentialClient = db,
) {
  const parsed = lifecycle
    .extend({
      reason: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[A-Z][A-Z0-9_]*$/u),
    })
    .safeParse(raw)
  if (!parsed.success) throw new PlatformWorkerPolicyCredentialError('INVALID_INPUT')
  const input = parsed.data
  const operationHash = hash({
    action: 'REVOKE',
    operationId: input.operationId,
    credentialId: input.credentialId,
    expectedUpdatedAt: input.expectedUpdatedAt.toISOString(),
    reason: input.reason,
    actorId: input.actor.id,
  })
  const replay = await client.platformWorkerPolicyCredential.findUnique({
    where: { revocationOperationId: input.operationId },
    select: { revocationHash: true, ...credentialSelect },
  })
  if (replay) {
    if (replay.revocationHash !== operationHash) throw conflict()
    const { revocationHash: _, ...credential } = replay
    void _
    return { credential, replayed: true as const }
  }
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const current = await tx.platformWorkerPolicyCredential.findFirst({
        where: { id: input.credentialId, revokedAt: null, updatedAt: input.expectedUpdatedAt },
        select: credentialSelect,
      })
      if (!current) throw conflict()
      const now = new Date()
      const changed = await tx.platformWorkerPolicyCredential.updateMany({
        where: {
          id: current.id,
          revokedAt: null,
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          enabled: false,
          revokedAt: now,
          revokedBy: input.actor.id,
          revokeReason: input.reason,
          revocationOperationId: input.operationId,
          revocationHash: operationHash,
        },
      })
      if (changed.count !== 1) throw conflict()
      const credential = await tx.platformWorkerPolicyCredential.findUniqueOrThrow({
        where: { id: current.id },
        select: credentialSelect,
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: 'PLATFORM_ADMIN',
          action: 'platform-worker-policy-credential.revoked',
          targetType: 'PlatformWorkerPolicyCredential',
          targetId: current.id,
          beforeState: { enabled: current.enabled },
          afterState: { workerId: current.workerId, enabled: false, reason: input.reason },
        },
        tx,
      )
      return { credential, replayed: false as const }
    })
  } catch (error) {
    const converged = await client.platformWorkerPolicyCredential.findUnique({
      where: { revocationOperationId: input.operationId },
      select: { revocationHash: true, ...credentialSelect },
    })
    if (converged?.revocationHash === operationHash) {
      const { revocationHash: _, ...credential } = converged
      void _
      return { credential, replayed: true as const }
    }
    return uniqueOrConflict(error)
  }
}

export async function verifyPlatformWorkerPolicyCredential(
  plaintext: string,
  client: PlatformWorkerPolicyCredentialClient = db,
) {
  return verifyPlatformWorkerPolicyCredentialCapability(plaintext, 'founder-decisions:read', client)
}

export async function verifyPlatformWorkerPolicyCredentialCapability(
  plaintext: string,
  capability: z.infer<typeof PlatformWorkerPolicyCapability>,
  client: PlatformWorkerPolicyCredentialClient = db,
) {
  if (!/^pf_platform_[A-Za-z0-9_-]{43}$/u.test(plaintext))
    throw new PlatformWorkerPolicyCredentialError('INACTIVE')
  const credential = await client.platformWorkerPolicyCredential.findFirst({
    where: {
      secretPrefix: plaintext.slice(0, 24),
      enabled: true,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      capabilities: { has: capability },
    },
    select: { id: true, workerId: true, capabilities: true, secretHash: true },
  })
  if (!credential) throw new PlatformWorkerPolicyCredentialError('INACTIVE')
  let valid = false
  try {
    valid = await argon2Verify({ password: plaintext, hash: credential.secretHash })
  } catch {
    valid = false
  }
  if (!valid) throw new PlatformWorkerPolicyCredentialError('INACTIVE')
  const verified = VerifiedPlatformWorkerPolicyCredential.parse({
    credentialId: credential.id,
    workerId: credential.workerId,
    capabilities: credential.capabilities,
  })
  await client.platformWorkerPolicyCredential.update({
    where: { id: credential.id },
    data: { lastUsedAt: new Date() },
  })
  return verified
}
