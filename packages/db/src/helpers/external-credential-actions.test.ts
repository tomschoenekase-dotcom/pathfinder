import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  activateAgentBridgeCredentialAction,
  ExternalCredentialActionError,
  issueExternalCredentialAction,
  revokeExternalCredentialAction,
  rotateExternalCredentialAction,
} from './external-credential-actions'

const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }
const input = {
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueId: null,
  operationId: '11111111-1111-4111-8111-111111111111',
  actor,
  kind: 'PARTNER_READ_API' as const,
  label: 'Read API',
  capabilities: ['clients:read'],
  expiresAt: null,
}
const credential = {
  id: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueId: null,
  scopeKey: '__CLIENT__',
  kind: 'PARTNER_READ_API',
  label: 'Read API',
  capabilities: ['clients:read'],
  secretPrefix: 'pf_read_opaque',
  hashAlgorithm: 'ARGON2ID',
  enabled: false,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdBy: actor.id,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function harness() {
  const tx = {
    tenant: { findFirst: vi.fn().mockResolvedValue({ id: 'tenant-1' }) },
    venue: { findFirst: vi.fn() },
    externalAccessCredential: {
      create: vi.fn().mockResolvedValue(credential),
      findFirst: vi.fn().mockResolvedValue(credential),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    externalCredentialRevocation: { create: vi.fn() },
    externalCredentialRotation: { create: vi.fn() },
    externalCredentialActivation: { create: vi.fn() },
    externalCredentialOperationReceipt: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  }
  const client = {
    $transaction: vi.fn(async (fn) => fn(tx)),
    externalAccessCredential: { findFirst: vi.fn() },
    externalCredentialOperationReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
    externalCredentialActivation: { findFirst: vi.fn().mockResolvedValue(null) },
  }
  return { tx, client }
}

describe('disabled external credential actions', () => {
  it('uses the portable Argon2id implementation and does not reintroduce the native addon', () => {
    const source = readFileSync(
      new URL('./external-credential-actions.ts', import.meta.url),
      'utf8',
    )
    const packageJson = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    expect(source).toContain("from 'hash-wasm'")
    expect(source).not.toMatch(/from ['"]argon2['"]/u)
    expect(packageJson).toContain('"hash-wasm"')
    expect(packageJson).not.toMatch(/"argon2"\s*:/u)
  })

  it('issues disabled with Argon2id and returns plaintext exactly once without persisting or auditing it', async () => {
    const { tx, client } = harness()
    const result = await issueExternalCredentialAction(input, client as never)
    expect(result).toMatchObject({ credential: { enabled: false }, replayed: false })
    expect(result.plaintextSecret).toMatch(/^pf_read_[A-Za-z0-9_-]{40,}$/u)
    const create = tx.externalAccessCredential.create.mock.calls[0]?.[0]
    expect(create.data.secretHash).toMatch(/^\$argon2id\$/u)
    expect(create.data.secretHash).toContain('$m=19456,t=2,p=1$')
    expect(create.data.secretHash).not.toContain(result.plaintextSecret)
    expect(JSON.stringify(tx.externalCredentialOperationReceipt.create.mock.calls)).not.toContain(
      result.plaintextSecret,
    )
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(result.plaintextSecret)
  })

  it('replays exact durable evidence without returning plaintext or hashing again', async () => {
    const first = harness()
    await issueExternalCredentialAction(input, first.client as never)
    const operationHash =
      first.tx.externalCredentialOperationReceipt.create.mock.calls[0]?.[0]?.data.operationHash
    const replay = harness()
    replay.client.externalCredentialOperationReceipt.findFirst.mockResolvedValue({
      operationHash,
      actorId: actor.id,
      credential,
    })
    await expect(
      issueExternalCredentialAction(input, replay.client as never),
    ).resolves.toMatchObject({ plaintextSecret: null, replayed: true })
    expect(replay.client.$transaction).not.toHaveBeenCalled()
  })

  it('activates only an exact venue MCP bridge credential with append-only evidence', async () => {
    const { tx, client } = harness()
    const bridgeCredential = {
      ...credential,
      venueId: 'venue-1',
      scopeKey: 'venue-1',
      kind: 'MCP',
      capabilities: ['agent-runs:execute'],
    }
    tx.externalAccessCredential.findFirst.mockResolvedValue(bridgeCredential)
    const result = await activateAgentBridgeCredentialAction(
      {
        tenantId: 'tenant-1',
        clientId: 'tenant-1',
        venueId: 'venue-1',
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        actor,
        credentialId: bridgeCredential.id,
        expectedUpdatedAt: bridgeCredential.updatedAt,
      },
      client as never,
    )
    expect(result).toMatchObject({ credential: { enabled: true }, plaintextSecret: null })
    expect(tx.externalCredentialActivation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentialId: bridgeCredential.id,
          venueId: 'venue-1',
          activatedBy: actor.id,
        }),
      }),
    )
    const activatedAt = tx.externalCredentialActivation.create.mock.calls[0]?.[0]?.data.activatedAt
    expect(tx.externalAccessCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { enabled: true, updatedAt: activatedAt } }),
    )
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toMatch(/secretHash|plaintext/u)
  })

  it('rejects wrong actor, scope mismatch, duplicates, and cross-kind capabilities before writes', async () => {
    for (const candidate of [
      { ...input, actor: { ...actor, role: 'OWNER' } },
      { ...input, clientId: 'tenant-2' },
      { ...input, capabilities: ['clients:read', 'clients:read'] },
      { ...input, capabilities: ['packages:draft'] },
    ]) {
      await expect(issueExternalCredentialAction(candidate, {} as never)).rejects.toBeInstanceOf(
        ExternalCredentialActionError,
      )
    }
  })

  it('rotates atomically, preserving scope and capabilities while returning the replacement secret once', async () => {
    const { tx, client } = harness()
    client.externalAccessCredential.findFirst.mockResolvedValue(credential)
    const replacement = { ...credential, id: 'credential-2', createdBy: actor.id }
    tx.externalAccessCredential.create.mockResolvedValue(replacement)
    const result = await rotateExternalCredentialAction(
      {
        tenantId: credential.tenantId,
        clientId: credential.clientId,
        venueId: credential.venueId,
        operationId: '22222222-2222-4222-8222-222222222222',
        actor,
        credentialId: credential.id,
        expectedUpdatedAt: credential.updatedAt,
      },
      client as never,
    )
    expect(result).toMatchObject({
      credential: { id: 'credential-2', enabled: false },
      replayed: false,
    })
    expect(result.plaintextSecret).toMatch(/^pf_read_/u)
    expect(tx.externalAccessCredential.updateMany).toHaveBeenCalledOnce()
    expect(tx.externalCredentialRevocation.create).toHaveBeenCalledOnce()
    expect(tx.externalCredentialRotation.create).toHaveBeenCalledOnce()
    const rotationAt = tx.externalCredentialRotation.create.mock.calls[0]?.[0]?.data.rotatedAt
    expect(tx.externalAccessCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { enabled: false, revokedAt: rotationAt, updatedAt: rotationAt },
      }),
    )
    expect(tx.externalCredentialOperationReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operationKind: 'ROTATE',
          credentialId: 'credential-2',
          previousCredentialId: credential.id,
          createdAt: rotationAt,
        }),
      }),
    )
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(result.plaintextSecret)
  })

  it('revokes atomically without producing plaintext', async () => {
    const { tx, client } = harness()
    const result = await revokeExternalCredentialAction(
      {
        tenantId: credential.tenantId,
        clientId: credential.clientId,
        venueId: credential.venueId,
        operationId: '33333333-3333-4333-8333-333333333333',
        actor,
        credentialId: credential.id,
        expectedUpdatedAt: credential.updatedAt,
        reasonCode: 'ADMIN_REVOKED',
      },
      client as never,
    )
    expect(result).toMatchObject({ plaintextSecret: null, replayed: false })
    expect(tx.externalCredentialRevocation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'ADMIN_REVOKED' }) }),
    )
    const revokedAt = tx.externalCredentialRevocation.create.mock.calls[0]?.[0]?.data.revokedAt
    expect(tx.externalAccessCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { enabled: false, revokedAt, updatedAt: revokedAt },
      }),
    )
    expect(tx.externalCredentialOperationReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operationKind: 'REVOKE', createdAt: revokedAt }),
      }),
    )
  })

  it('converges a rotate transaction race through a fresh receipt read without reissuing plaintext', async () => {
    const first = harness()
    first.client.externalAccessCredential.findFirst.mockResolvedValue(credential)
    first.client.$transaction.mockRejectedValueOnce({ code: 'P2034' })
    const replayed = { ...credential, id: 'credential-2' }
    first.client.externalCredentialOperationReceipt.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        operationHash: expect.anything(),
        actorId: actor.id,
        credential: replayed,
      })
    // Capture the canonical hash from an equivalent successful attempt.
    const successful = harness()
    successful.client.externalAccessCredential.findFirst.mockResolvedValue(credential)
    successful.tx.externalAccessCredential.create.mockResolvedValue(replayed)
    await rotateExternalCredentialAction(
      {
        tenantId: credential.tenantId,
        clientId: credential.clientId,
        venueId: credential.venueId,
        operationId: '44444444-4444-4444-8444-444444444444',
        actor,
        credentialId: credential.id,
        expectedUpdatedAt: credential.updatedAt,
      },
      successful.client as never,
    )
    const receipt = successful.tx.externalCredentialOperationReceipt.create.mock.calls[0]?.[0]?.data
    first.client.externalCredentialOperationReceipt.findFirst.mockReset()
    first.client.externalCredentialOperationReceipt.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        operationHash: receipt.operationHash,
        actorId: actor.id,
        credential: replayed,
      })
    const result = await rotateExternalCredentialAction(
      {
        tenantId: credential.tenantId,
        clientId: credential.clientId,
        venueId: credential.venueId,
        operationId: '44444444-4444-4444-8444-444444444444',
        actor,
        credentialId: credential.id,
        expectedUpdatedAt: credential.updatedAt,
      },
      first.client as never,
    )
    expect(result).toMatchObject({ plaintextSecret: null, replayed: true })
    expect(first.client.externalCredentialOperationReceipt.findFirst).toHaveBeenCalledTimes(2)
  })
})
