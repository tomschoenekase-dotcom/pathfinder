import { argon2id } from 'hash-wasm'
import { describe, expect, it, vi } from 'vitest'

import {
  ExternalCredentialVerificationError,
  verifyAgentBridgeCredential,
} from './external-credential-verification'

const plaintext = `pf_mcp_${'a'.repeat(43)}`

async function verifier() {
  return argon2id({
    password: plaintext,
    salt: new Uint8Array(16).fill(7),
    memorySize: 19_456,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
    outputType: 'encoded',
  })
}

describe('agent bridge machine credential verification', () => {
  it('returns only bounded verified scope for an active exact-venue credential', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'credential-1',
      tenantId: 'tenant-1',
      clientId: 'tenant-1',
      venueId: 'venue-1',
      capabilities: ['agent-runs:execute', 'questions:ask'],
      secretHash: await verifier(),
    })
    const result = await verifyAgentBridgeCredential(
      { tenantId: 'tenant-1', venueId: 'venue-1', plaintext },
      { externalAccessCredential: { findFirst } } as never,
    )
    expect(result).toEqual({
      credentialId: 'credential-1',
      tenantId: 'tenant-1',
      clientId: 'tenant-1',
      venueIds: ['venue-1'],
      capabilities: ['agent-runs:execute', 'questions:ask'],
    })
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          clientId: 'tenant-1',
          venueId: 'venue-1',
          secretPrefix: plaintext.slice(0, 20),
          enabled: true,
          revokedAt: null,
          capabilities: { has: 'agent-runs:execute' },
        }),
      }),
    )
  })

  it('fails with one non-secret message for malformed, missing, and wrong secrets', async () => {
    const cases = [
      { value: 'SECRET_SENTINEL', record: null },
      { value: plaintext, record: null },
      {
        value: `pf_mcp_${'b'.repeat(43)}`,
        record: {
          id: 'credential-1',
          tenantId: 'tenant-1',
          clientId: 'tenant-1',
          venueId: 'venue-1',
          capabilities: ['agent-runs:execute'],
          secretHash: await verifier(),
        },
      },
    ]
    for (const candidate of cases) {
      const error = await verifyAgentBridgeCredential(
        { tenantId: 'tenant-1', venueId: 'venue-1', plaintext: candidate.value },
        {
          externalAccessCredential: { findFirst: vi.fn().mockResolvedValue(candidate.record) },
        } as never,
      ).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ExternalCredentialVerificationError)
      expect(String(error)).toBe(
        'ExternalCredentialVerificationError: Machine credential is invalid or inactive',
      )
      expect(String(error)).not.toContain(candidate.value)
    }
  })
})
