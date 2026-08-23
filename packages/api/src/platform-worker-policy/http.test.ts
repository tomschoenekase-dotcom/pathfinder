import { describe, expect, it, vi } from 'vitest'

import { handlePlatformWorkerFounderDecisionRequest } from './http'

const secret = `pf_platform_${'a'.repeat(43)}`
const request = (payload: unknown, token = secret) =>
  new Request('http://localhost/api/platform-worker/founder-decisions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

describe('platform worker founder decision HTTP boundary', () => {
  it('returns exact current truth and strictly audits the machine read', async () => {
    const audit = vi.fn()
    const response = await handlePlatformWorkerFounderDecisionRequest(
      request({ keys: ['codex-autonomy'] }),
      {
        verify: vi.fn().mockResolvedValue({
          credentialId: 'credential-1',
          workerId: 'edith-primary',
          capabilities: ['founder-decisions:read'],
        }),
        resolve: vi.fn().mockResolvedValue({
          schemaVersion: 'founder-decision-current-truth.v1',
          complete: true,
          decisions: [{ key: 'codex-autonomy' }],
          missingKeys: [],
          resolution: {},
        }),
        audit,
      },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      complete: true,
      decisions: [{ key: 'codex-autonomy' }],
    })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'AGENT',
        credentialId: 'credential-1',
        capability: 'founder-decisions:read',
      }),
    )
  })

  it('rejects customer MCP tokens and invalid or duplicate keys', async () => {
    const verify = vi.fn()
    const customer = await handlePlatformWorkerFounderDecisionRequest(
      request({ keys: ['codex-autonomy'] }, `pf_mcp_${'a'.repeat(43)}`),
      { verify },
    )
    expect(customer.status).toBe(401)
    expect(verify).not.toHaveBeenCalled()
    const invalid = await handlePlatformWorkerFounderDecisionRequest(
      request({ keys: ['codex-autonomy', 'codex-autonomy'] }),
      {
        verify: vi.fn().mockResolvedValue({
          credentialId: 'c',
          workerId: 'w',
          capabilities: ['founder-decisions:read'],
        }),
      },
    )
    expect(invalid.status).toBe(400)
  })

  it('bounds request bytes before policy resolution', async () => {
    const resolve = vi.fn()
    const oversized = new Request('http://localhost/api/platform-worker/founder-decisions', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ keys: ['a'.repeat(33_000)] }),
    })
    const response = await handlePlatformWorkerFounderDecisionRequest(oversized, {
      verify: vi.fn().mockResolvedValue({
        credentialId: 'c',
        workerId: 'w',
        capabilities: ['founder-decisions:read'],
      }),
      resolve,
    })
    expect(response.status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('fails closed when current truth is ambiguous', async () => {
    const response = await handlePlatformWorkerFounderDecisionRequest(
      request({ keys: ['codex-autonomy'] }),
      {
        verify: vi.fn().mockResolvedValue({
          credentialId: 'c',
          workerId: 'w',
          capabilities: ['founder-decisions:read'],
        }),
        resolve: vi.fn().mockRejectedValue(new Error('ambiguous')),
      },
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'POLICY_RECONCILIATION_REQUIRED' })
  })

  it('rate-limits before expensive credential verification', async () => {
    const verify = vi.fn()
    const response = await handlePlatformWorkerFounderDecisionRequest(
      request({ keys: ['codex-autonomy'] }),
      { verify, allowAttempt: () => false },
    )
    expect(response.status).toBe(429)
    expect(verify).not.toHaveBeenCalled()
  })
})
