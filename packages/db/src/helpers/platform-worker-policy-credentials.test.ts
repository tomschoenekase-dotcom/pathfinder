import { describe, expect, it, vi } from 'vitest'

import {
  activatePlatformWorkerPolicyCredentialAction,
  issuePlatformWorkerPolicyCredentialAction,
  revokePlatformWorkerPolicyCredentialAction,
  verifyPlatformWorkerPolicyCredential,
} from './platform-worker-policy-credentials'

const actor = { type: 'HUMAN' as const, id: 'founder-1', role: 'PLATFORM_ADMIN' as const }

describe('platform worker policy credentials', () => {
  it('issues a one-time secret while leaving the credential disabled', async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'credential-1',
      ...data,
      hashAlgorithm: 'ARGON2ID',
      revokedAt: null,
      lastUsedAt: null,
      activatedBy: null,
      activatedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    const auditLog = { create: vi.fn() }
    const client = {
      platformWorkerPolicyCredential: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: (callback: (tx: unknown) => unknown) =>
        callback({ platformWorkerPolicyCredential: { create }, auditLog }),
    }
    const result = await issuePlatformWorkerPolicyCredentialAction(
      {
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        workerId: 'edith-primary',
        label: 'EDITH policy reader',
        capabilities: ['founder-decisions:read'],
        expiresAt: null,
        actor,
      },
      client as never,
    )
    expect(result.plaintextSecret).toMatch(/^pf_platform_[A-Za-z0-9_-]{43}$/u)
    expect(result.credential.enabled).toBe(false)
    expect(create.mock.calls[0]![0].data).not.toHaveProperty('plaintextSecret')
    expect(auditLog.create).toHaveBeenCalledOnce()
  })

  it('activates and revokes through explicit optimistic lifecycle changes', async () => {
    const base = {
      id: 'credential-1',
      workerId: 'edith-primary',
      label: 'EDITH',
      capabilities: ['founder-decisions:read'],
      secretPrefix: 'pf_platform_opaque',
      hashAlgorithm: 'ARGON2ID',
      enabled: false,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdBy: 'founder-1',
      activatedBy: null,
      activatedAt: null,
      createdAt: new Date(),
      updatedAt: new Date('2026-08-23T10:30:00Z'),
    }
    const writes: Array<Record<string, unknown>> = []
    const updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data)
      return { count: 1 }
    })
    const auditLog = { create: vi.fn() }
    const client = {
      platformWorkerPolicyCredential: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: (callback: (tx: unknown) => unknown) =>
        callback({
          platformWorkerPolicyCredential: {
            findFirst: vi.fn().mockResolvedValue(base),
            updateMany,
            findUniqueOrThrow: vi.fn(async () => ({ ...base, ...writes.at(-1) })),
          },
          auditLog,
        }),
    }
    const activated = await activatePlatformWorkerPolicyCredentialAction(
      {
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        credentialId: base.id,
        expectedUpdatedAt: base.updatedAt,
        actor,
      },
      client as never,
    )
    expect(activated.credential.enabled).toBe(true)
    const revoked = await revokePlatformWorkerPolicyCredentialAction(
      {
        operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        credentialId: base.id,
        expectedUpdatedAt: base.updatedAt,
        reason: 'ROTATED',
        actor,
      },
      client as never,
    )
    expect(revoked.credential.enabled).toBe(false)
    expect(updateMany).toHaveBeenCalledTimes(2)
  })

  it('rejects tenant MCP-shaped plaintext before querying storage', async () => {
    const findFirst = vi.fn()
    await expect(
      verifyPlatformWorkerPolicyCredential(`pf_mcp_${'a'.repeat(43)}`, {
        platformWorkerPolicyCredential: { findFirst },
      } as never),
    ).rejects.toThrow(/invalid or inactive/u)
    expect(findFirst).not.toHaveBeenCalled()
  })
})
