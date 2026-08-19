import { createHash, randomBytes } from 'node:crypto'
import { argon2id } from 'hash-wasm'
import { z } from 'zod'

import { McpCapability } from '@pathfinder/contracts/mcp-v0'
import { PartnerReadCapability } from '@pathfinder/contracts/partner-read-api'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const actorSchema = z
  .object({
    type: z.literal('HUMAN'),
    id: z.string().trim().min(1).max(191),
    role: z.literal('PLATFORM_ADMIN'),
  })
  .strict()
const scopeSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191).nullable(),
  })
  .strict()
const commonSchema = scopeSchema
  .extend({
    operationId: z.string().uuid(),
    actor: actorSchema,
    kind: z.enum(['MCP', 'PARTNER_READ_API']),
    label: z.string().trim().min(1).max(200),
    capabilities: z.array(z.string()).min(1).max(50),
    expiresAt: z.date().nullable(),
  })
  .strict()
const credentialSelect = {
  id: true,
  tenantId: true,
  clientId: true,
  venueId: true,
  scopeKey: true,
  kind: true,
  label: true,
  capabilities: true,
  secretPrefix: true,
  hashAlgorithm: true,
  enabled: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const

export type ExternalCredentialActor = z.infer<typeof actorSchema>
export type ExternalCredentialActionClient = Pick<
  typeof db,
  | '$transaction'
  | 'externalAccessCredential'
  | 'externalCredentialOperationReceipt'
  | 'externalCredentialActivation'
>
export class ExternalCredentialActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ExternalCredentialActionError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function operationHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
function scopeKey(venueId: string | null) {
  return venueId ?? '__CLIENT__'
}
function parseCapabilities(kind: 'MCP' | 'PARTNER_READ_API', values: string[]) {
  const schema = kind === 'MCP' ? McpCapability : PartnerReadCapability
  const parsed = z
    .array(schema)
    .min(1)
    .max(schema.options.length)
    .safeParse([...new Set(values)].sort())
  if (!parsed.success || parsed.data.length !== values.length)
    throw new ExternalCredentialActionError('INVALID_INPUT', 'Invalid credential capabilities')
  return parsed.data
}
function secret(kind: 'MCP' | 'PARTNER_READ_API') {
  const plaintext = `pf_${kind === 'MCP' ? 'mcp' : 'read'}_${randomBytes(32).toString('base64url')}`
  return { plaintext, prefix: plaintext.slice(0, 20) }
}
async function secretHash(plaintext: string) {
  return argon2id({
    password: plaintext,
    salt: randomBytes(16),
    memorySize: 19_456,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
    outputType: 'encoded',
  })
}
function isP2002(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}
function isP2034(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2034')
}

async function replay(
  client: ExternalCredentialActionClient,
  input: { operationId: string; operationHash: string; actorId: string },
) {
  const receipt = await client.externalCredentialOperationReceipt.findFirst({
    where: { operationId: input.operationId },
    select: { operationHash: true, actorId: true, credential: { select: credentialSelect } },
  })
  if (!receipt) return null
  if (receipt.operationHash !== input.operationHash || receipt.actorId !== input.actorId)
    throw new ExternalCredentialActionError(
      'CONFLICT',
      'Operation ID is bound to different credential evidence',
    )
  return { credential: receipt.credential, plaintextSecret: null, replayed: true as const }
}

export async function issueExternalCredentialAction(
  raw: unknown,
  client: ExternalCredentialActionClient = db,
) {
  const parsed = commonSchema.safeParse(raw)
  if (!parsed.success)
    throw new ExternalCredentialActionError('INVALID_INPUT', 'Invalid credential issue request')
  const input = parsed.data
  if (input.tenantId !== input.clientId)
    throw new ExternalCredentialActionError('INVALID_INPUT', 'Client must match tenant scope')
  const actor = input.actor
  const capabilities = parseCapabilities(input.kind, input.capabilities)
  const opHash = operationHash({
    action: 'ISSUE',
    tenantId: input.tenantId,
    clientId: input.clientId,
    venueId: input.venueId,
    operationId: input.operationId,
    kind: input.kind,
    label: input.label,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    capabilities,
    actorId: actor.id,
  })
  const prior = await replay(client, {
    operationId: input.operationId,
    operationHash: opHash,
    actorId: actor.id,
  })
  if (prior) return prior
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const generated = secret(input.kind)
    const verifier = await secretHash(generated.plaintext)
    try {
      const credential = await client.$transaction(async (rawTx) => {
        const tx = rawTx as unknown as typeof db
        const now = new Date()
        const venue = input.venueId
          ? await tx.venue.findFirst({
              where: { id: input.venueId, tenantId: input.tenantId },
              select: { id: true },
            })
          : await tx.tenant.findFirst({ where: { id: input.tenantId }, select: { id: true } })
        if (!venue)
          throw new ExternalCredentialActionError('NOT_FOUND', 'Credential scope not found')
        const created = await tx.externalAccessCredential.create({
          data: {
            tenantId: input.tenantId,
            clientId: input.clientId,
            venueId: input.venueId,
            scopeKey: scopeKey(input.venueId),
            kind: input.kind,
            label: input.label,
            capabilities,
            secretPrefix: generated.prefix,
            secretHash: verifier,
            hashAlgorithm: 'ARGON2ID',
            enabled: false,
            expiresAt: input.expiresAt,
            createdBy: actor.id,
            createdAt: now,
          },
          select: credentialSelect,
        })
        await tx.externalCredentialOperationReceipt.create({
          data: {
            operationId: input.operationId,
            operationHash: opHash,
            operationKind: 'ISSUE',
            tenantId: input.tenantId,
            clientId: input.clientId,
            venueId: input.venueId,
            scopeKey: scopeKey(input.venueId),
            credentialId: created.id,
            actorId: actor.id,
            createdAt: now,
          },
        })
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: actor.id,
            actorRole: 'PLATFORM_ADMIN',
            action: 'external-credential.issued-disabled',
            targetType: 'ExternalAccessCredential',
            targetId: created.id,
            afterState: {
              clientId: input.clientId,
              venueId: input.venueId,
              kind: input.kind,
              capabilities,
              enabled: false,
            },
          },
          tx,
        )
        return created
      })
      return { credential, plaintextSecret: generated.plaintext, replayed: false as const }
    } catch (error) {
      if (!isP2002(error) && !isP2034(error)) throw error
      const converged = await replay(client, {
        operationId: input.operationId,
        operationHash: opHash,
        actorId: actor.id,
      })
      if (converged) return converged
      if (attempt === 3)
        throw new ExternalCredentialActionError('CONFLICT', 'Credential prefix collision')
    }
  }
  throw new ExternalCredentialActionError('CONFLICT', 'Credential issue did not converge')
}

const lifecycleSchema = scopeSchema
  .extend({
    operationId: z.string().uuid(),
    actor: actorSchema,
    credentialId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.date(),
  })
  .strict()

const bridgeActivationSchema = lifecycleSchema.extend({
  venueId: z.string().trim().min(1).max(191),
})

/** Activates one exact venue-scoped MCP bridge credential. Activation is
 * idempotent, append-only evidenced, and never reads or returns plaintext. */
export async function activateAgentBridgeCredentialAction(
  raw: unknown,
  client: ExternalCredentialActionClient = db,
) {
  const parsed = bridgeActivationSchema.safeParse(raw)
  if (!parsed.success)
    throw new ExternalCredentialActionError('INVALID_INPUT', 'Invalid bridge activation request')
  const input = parsed.data
  if (input.tenantId !== input.clientId)
    throw new ExternalCredentialActionError('INVALID_INPUT', 'Client must match tenant scope')
  const opHash = operationHash({
    action: 'ACTIVATE_AGENT_BRIDGE',
    operationId: input.operationId,
    tenantId: input.tenantId,
    clientId: input.clientId,
    venueId: input.venueId,
    credentialId: input.credentialId,
    expectedUpdatedAt: input.expectedUpdatedAt.toISOString(),
    actorId: input.actor.id,
  })
  const prior = await client.externalCredentialActivation.findFirst({
    where: { operationId: input.operationId },
    select: { operationHash: true, activatedBy: true, credential: { select: credentialSelect } },
  })
  if (prior) {
    if (prior.operationHash !== opHash || prior.activatedBy !== input.actor.id)
      throw new ExternalCredentialActionError(
        'CONFLICT',
        'Operation ID is bound to different activation evidence',
      )
    return { credential: prior.credential, plaintextSecret: null, replayed: true as const }
  }
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const credential = await tx.externalAccessCredential.findFirst({
        where: {
          id: input.credentialId,
          tenantId: input.tenantId,
          clientId: input.clientId,
          venueId: input.venueId,
          kind: 'MCP',
          enabled: false,
          revokedAt: null,
          updatedAt: input.expectedUpdatedAt,
          capabilities: { has: 'agent-runs:execute' },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: credentialSelect,
      })
      if (!credential)
        throw new ExternalCredentialActionError(
          'CONFLICT',
          'Credential is not eligible for bridge activation',
        )
      const activatedAt = new Date()
      await tx.externalCredentialActivation.create({
        data: {
          operationId: input.operationId,
          operationHash: opHash,
          tenantId: credential.tenantId,
          clientId: credential.clientId,
          venueId: input.venueId,
          scopeKey: credential.scopeKey,
          credentialId: credential.id,
          activatedBy: input.actor.id,
          activatedAt,
        },
      })
      const changed = await tx.externalAccessCredential.updateMany({
        where: {
          id: credential.id,
          tenantId: credential.tenantId,
          clientId: credential.clientId,
          venueId: input.venueId,
          enabled: false,
          revokedAt: null,
          updatedAt: input.expectedUpdatedAt,
        },
        data: { enabled: true, updatedAt: activatedAt },
      })
      if (changed.count !== 1)
        throw new ExternalCredentialActionError('CONFLICT', 'Credential state changed')
      await writeAuditLogStrict(
        {
          tenantId: credential.tenantId,
          actorId: input.actor.id,
          actorRole: 'PLATFORM_ADMIN',
          action: 'external-credential.agent-bridge-activated',
          targetType: 'ExternalAccessCredential',
          targetId: credential.id,
          beforeState: { enabled: false },
          afterState: {
            venueId: input.venueId,
            kind: 'MCP',
            capabilities: credential.capabilities,
            enabled: true,
          },
        },
        tx,
      )
      return {
        credential: { ...credential, enabled: true, updatedAt: activatedAt },
        plaintextSecret: null,
        replayed: false as const,
      }
    })
  } catch (error) {
    const replayableRace = isP2002(error) || isP2034(error)
    if (!replayableRace) throw error
    const converged = await client.externalCredentialActivation.findFirst({
      where: { operationId: input.operationId },
      select: { operationHash: true, activatedBy: true, credential: { select: credentialSelect } },
    })
    if (converged?.operationHash === opHash && converged.activatedBy === input.actor.id)
      return { credential: converged.credential, plaintextSecret: null, replayed: true as const }
    throw new ExternalCredentialActionError('CONFLICT', 'Credential activation did not converge')
  }
}

export async function rotateExternalCredentialAction(
  raw: unknown,
  client: ExternalCredentialActionClient = db,
) {
  const parsed = lifecycleSchema.safeParse(raw)
  if (!parsed.success)
    throw new ExternalCredentialActionError('INVALID_INPUT', 'Invalid credential rotation request')
  const input = parsed.data
  if (input.tenantId !== input.clientId)
    throw new ExternalCredentialActionError('INVALID_INPUT', 'Client must match tenant scope')
  const opHash = operationHash({
    action: 'ROTATE',
    operationId: input.operationId,
    tenantId: input.tenantId,
    clientId: input.clientId,
    venueId: input.venueId,
    credentialId: input.credentialId,
    expectedUpdatedAt: input.expectedUpdatedAt.toISOString(),
    actorId: input.actor.id,
  })
  const prior = await replay(client, {
    operationId: input.operationId,
    operationHash: opHash,
    actorId: input.actor.id,
  })
  if (prior) return prior
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const old = await client.externalAccessCredential.findFirst({
      where: {
        id: input.credentialId,
        tenantId: input.tenantId,
        clientId: input.clientId,
        venueId: input.venueId,
      },
      select: { ...credentialSelect },
    })
    if (!old) throw new ExternalCredentialActionError('NOT_FOUND', 'Credential not found')
    if (old.revokedAt || old.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
      throw new ExternalCredentialActionError('CONFLICT', 'Credential state changed')
    const generated = secret(old.kind)
    const verifier = await secretHash(generated.plaintext)
    try {
      const credential = await client.$transaction(async (rawTx) => {
        const tx = rawTx as unknown as typeof db
        const now = new Date()
        const changed = await tx.externalAccessCredential.updateMany({
          where: {
            id: old.id,
            tenantId: old.tenantId,
            clientId: old.clientId,
            venueId: old.venueId,
            revokedAt: null,
            updatedAt: input.expectedUpdatedAt,
          },
          data: { enabled: false, revokedAt: now, updatedAt: now },
        })
        if (changed.count !== 1)
          throw new ExternalCredentialActionError('CONFLICT', 'Credential state changed')
        const created = await tx.externalAccessCredential.create({
          data: {
            tenantId: old.tenantId,
            clientId: old.clientId,
            venueId: old.venueId,
            scopeKey: old.scopeKey,
            kind: old.kind,
            label: old.label,
            capabilities: old.capabilities,
            secretPrefix: generated.prefix,
            secretHash: verifier,
            hashAlgorithm: 'ARGON2ID',
            enabled: false,
            expiresAt: old.expiresAt,
            createdBy: input.actor.id,
            createdAt: now,
          },
          select: credentialSelect,
        })
        await tx.externalCredentialRevocation.create({
          data: {
            tenantId: old.tenantId,
            clientId: old.clientId,
            venueId: old.venueId,
            scopeKey: old.scopeKey,
            credentialId: old.id,
            revokedBy: input.actor.id,
            reasonCode: 'ROTATED',
            revokedAt: now,
          },
        })
        await tx.externalCredentialRotation.create({
          data: {
            tenantId: old.tenantId,
            clientId: old.clientId,
            venueId: old.venueId,
            scopeKey: old.scopeKey,
            previousCredentialId: old.id,
            newCredentialId: created.id,
            rotatedBy: input.actor.id,
            rotatedAt: now,
          },
        })
        await tx.externalCredentialOperationReceipt.create({
          data: {
            operationId: input.operationId,
            operationHash: opHash,
            operationKind: 'ROTATE',
            tenantId: old.tenantId,
            clientId: old.clientId,
            venueId: old.venueId,
            scopeKey: old.scopeKey,
            credentialId: created.id,
            previousCredentialId: old.id,
            actorId: input.actor.id,
            createdAt: now,
          },
        })
        await writeAuditLogStrict(
          {
            tenantId: old.tenantId,
            actorId: input.actor.id,
            actorRole: 'PLATFORM_ADMIN',
            action: 'external-credential.rotated-disabled',
            targetType: 'ExternalAccessCredential',
            targetId: created.id,
            beforeState: { previousCredentialId: old.id, enabled: false },
            afterState: { venueId: old.venueId, kind: old.kind, enabled: false },
          },
          tx,
        )
        return created
      })
      return { credential, plaintextSecret: generated.plaintext, replayed: false as const }
    } catch (error) {
      const replayableRace =
        isP2002(error) ||
        isP2034(error) ||
        (error instanceof ExternalCredentialActionError && error.code === 'CONFLICT')
      if (!replayableRace) throw error
      const converged = await replay(client, {
        operationId: input.operationId,
        operationHash: opHash,
        actorId: input.actor.id,
      })
      if (converged) return converged
      if (!isP2002(error)) throw error
      if (attempt === 3)
        throw new ExternalCredentialActionError('CONFLICT', 'Credential prefix collision')
    }
  }
  throw new ExternalCredentialActionError('CONFLICT', 'Credential rotation did not converge')
}

export async function revokeExternalCredentialAction(
  raw: unknown,
  client: ExternalCredentialActionClient = db,
) {
  const parsed = lifecycleSchema
    .extend({
      reasonCode: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[A-Z][A-Z0-9_]*$/u),
    })
    .safeParse(raw)
  if (!parsed.success)
    throw new ExternalCredentialActionError(
      'INVALID_INPUT',
      'Invalid credential revocation request',
    )
  const input = parsed.data
  if (input.tenantId !== input.clientId)
    throw new ExternalCredentialActionError('INVALID_INPUT', 'Client must match tenant scope')
  const opHash = operationHash({
    action: 'REVOKE',
    operationId: input.operationId,
    tenantId: input.tenantId,
    clientId: input.clientId,
    venueId: input.venueId,
    credentialId: input.credentialId,
    expectedUpdatedAt: input.expectedUpdatedAt.toISOString(),
    reasonCode: input.reasonCode,
    actorId: input.actor.id,
  })
  const prior = await replay(client, {
    operationId: input.operationId,
    operationHash: opHash,
    actorId: input.actor.id,
  })
  if (prior) return { ...prior, plaintextSecret: null }
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const credential = await tx.externalAccessCredential.findFirst({
        where: {
          id: input.credentialId,
          tenantId: input.tenantId,
          clientId: input.clientId,
          venueId: input.venueId,
        },
        select: credentialSelect,
      })
      if (!credential) throw new ExternalCredentialActionError('NOT_FOUND', 'Credential not found')
      if (
        credential.revokedAt ||
        credential.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
      )
        throw new ExternalCredentialActionError('CONFLICT', 'Credential state changed')
      const now = new Date()
      const changed = await tx.externalAccessCredential.updateMany({
        where: {
          id: credential.id,
          tenantId: credential.tenantId,
          clientId: credential.clientId,
          venueId: credential.venueId,
          revokedAt: null,
          updatedAt: input.expectedUpdatedAt,
        },
        data: { enabled: false, revokedAt: now, updatedAt: now },
      })
      if (changed.count !== 1)
        throw new ExternalCredentialActionError('CONFLICT', 'Credential state changed')
      await tx.externalCredentialRevocation.create({
        data: {
          tenantId: credential.tenantId,
          clientId: credential.clientId,
          venueId: credential.venueId,
          scopeKey: credential.scopeKey,
          credentialId: credential.id,
          revokedBy: input.actor.id,
          reasonCode: input.reasonCode,
          revokedAt: now,
        },
      })
      await tx.externalCredentialOperationReceipt.create({
        data: {
          operationId: input.operationId,
          operationHash: opHash,
          operationKind: 'REVOKE',
          tenantId: credential.tenantId,
          clientId: credential.clientId,
          venueId: credential.venueId,
          scopeKey: credential.scopeKey,
          credentialId: credential.id,
          actorId: input.actor.id,
          createdAt: now,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: credential.tenantId,
          actorId: input.actor.id,
          actorRole: 'PLATFORM_ADMIN',
          action: 'external-credential.revoked',
          targetType: 'ExternalAccessCredential',
          targetId: credential.id,
          beforeState: { enabled: credential.enabled },
          afterState: {
            venueId: credential.venueId,
            reasonCode: input.reasonCode,
            enabled: false,
            revoked: true,
          },
        },
        tx,
      )
      return {
        credential: { ...credential, revokedAt: now, updatedAt: now },
        plaintextSecret: null,
        replayed: false as const,
      }
    })
  } catch (error) {
    const replayableRace =
      isP2002(error) ||
      isP2034(error) ||
      (error instanceof ExternalCredentialActionError && error.code === 'CONFLICT')
    if (!replayableRace) throw error
    const converged = await replay(client, {
      operationId: input.operationId,
      operationHash: opHash,
      actorId: input.actor.id,
    })
    if (converged) return { ...converged, plaintextSecret: null }
    if (error instanceof ExternalCredentialActionError) throw error
    throw new ExternalCredentialActionError('CONFLICT', 'Credential revocation did not converge')
  }
}
