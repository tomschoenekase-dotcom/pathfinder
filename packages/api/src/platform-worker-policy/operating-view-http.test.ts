import { describe, expect, it, vi } from 'vitest'

import { handlePlatformWorkerFounderOperatingViewRequest } from './operating-view-http'

const secret = `pf_platform_${'a'.repeat(43)}`
const request = (payload: unknown, token = secret) =>
  new Request('http://localhost/api/platform-worker/founder-operating-view', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

describe('platform worker founder operating view HTTP boundary', () => {
  it('returns and strictly audits a read-only bounded operating view', async () => {
    const audit = vi.fn()
    const resolve = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      effect: 'READ_ONLY',
      authority: { transport: 'PLATFORM_WORKER_CREDENTIAL', canExecute: false },
      autonomyEvidence: { policy: { approvalReductionRecommended: false } },
    })
    const verify = vi.fn().mockResolvedValue({
      credentialId: 'credential-1',
      workerId: 'edith-primary',
      capabilities: ['founder-operating-view:read'],
    })
    const response = await handlePlatformWorkerFounderOperatingViewRequest(request({ limit: 10 }), {
      verify,
      resolve,
      audit,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      effect: 'READ_ONLY',
      authority: { transport: 'PLATFORM_WORKER_CREDENTIAL', canExecute: false },
      autonomyEvidence: { policy: { approvalReductionRecommended: false } },
    })
    expect(verify).toHaveBeenCalledWith(secret, 'founder-operating-view:read')
    expect(resolve).toHaveBeenCalledWith('edith-primary', 10)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'AGENT',
        credentialId: 'credential-1',
        capability: 'founder-operating-view:read',
      }),
    )
  })

  it('rejects a customer MCP token and an over-broad request', async () => {
    const verify = vi.fn()
    const customer = await handlePlatformWorkerFounderOperatingViewRequest(
      request({}, `pf_mcp_${'a'.repeat(43)}`),
      { verify },
    )
    expect(customer.status).toBe(401)
    expect(verify).not.toHaveBeenCalled()

    const invalid = await handlePlatformWorkerFounderOperatingViewRequest(
      request({ limit: 10, execute: true }),
      {
        verify: vi.fn().mockResolvedValue({
          credentialId: 'c',
          workerId: 'w',
          capabilities: ['founder-operating-view:read'],
        }),
      },
    )
    expect(invalid.status).toBe(400)
  })

  it('fails closed when the platform snapshot or strict audit is unavailable', async () => {
    const response = await handlePlatformWorkerFounderOperatingViewRequest(request({}), {
      verify: vi.fn().mockResolvedValue({
        credentialId: 'c',
        workerId: 'w',
        capabilities: ['founder-operating-view:read'],
      }),
      resolve: vi.fn().mockRejectedValue(new Error('unavailable')),
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'OPERATING_VIEW_UNAVAILABLE' })
  })
})
