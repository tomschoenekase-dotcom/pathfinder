import { describe, expect, it, vi } from 'vitest'

import { handlePlatformWorkerOperationsReadinessRequest } from './operations-readiness-http'

const secret = `pf_platform_${'a'.repeat(43)}`
const request = (payload: unknown = {}, token = secret) =>
  new Request('http://localhost/api/platform-worker/operations-readiness', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

describe('platform worker operations readiness HTTP boundary', () => {
  it('returns and strictly audits bounded platform queue health', async () => {
    const verify = vi.fn().mockResolvedValue({
      credentialId: 'credential-1',
      workerId: 'edith-primary',
      capabilities: ['operations-readiness:read'],
    })
    const audit = vi.fn()
    const resolve = vi.fn().mockResolvedValue({
      schemaVersion: 'pathfinder.operations-readiness.v4',
      status: 'degraded',
      queue: {
        live: {
          status: 'observed',
          source: 'bullmq-redis',
          coverage: { expectedQueues: 20, observedQueues: 20, complete: true },
          totalDepth: 2,
          totalFailed: 1,
          pausedQueues: 0,
          jobSchedulers: 4,
          oldestAgeMs: 12_000,
          queues: [],
        },
      },
      boundaries: {
        jobIdentityIncluded: false,
        payloadOrFailureDetailIncluded: false,
        retryAuthorized: false,
      },
    })
    const response = await handlePlatformWorkerOperationsReadinessRequest(request(), {
      verify,
      resolve,
      audit,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      status: 'degraded',
      queue: { live: { status: 'observed', totalDepth: 2 } },
      boundaries: { retryAuthorized: false },
    })
    expect(verify).toHaveBeenCalledWith(secret, 'operations-readiness:read')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'AGENT',
        credentialId: 'credential-1',
        capability: 'operations-readiness:read',
        afterState: expect.objectContaining({ liveQueueCoverage: true }),
      }),
    )
  })

  it('rejects customer MCP tokens and nonempty selectors before resolution', async () => {
    const verify = vi.fn()
    const customer = await handlePlatformWorkerOperationsReadinessRequest(
      request({}, `pf_mcp_${'a'.repeat(43)}`),
      { verify },
    )
    expect(customer.status).toBe(401)
    expect(verify).not.toHaveBeenCalled()

    const resolve = vi.fn()
    const invalid = await handlePlatformWorkerOperationsReadinessRequest(
      request({ queue: 'send-email' }),
      {
        verify: vi.fn().mockResolvedValue({
          credentialId: 'c',
          workerId: 'w',
          capabilities: ['operations-readiness:read'],
        }),
        resolve,
      },
    )
    expect(invalid.status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('fails closed when snapshot construction or strict audit is unavailable', async () => {
    const verify = vi.fn().mockResolvedValue({
      credentialId: 'c',
      workerId: 'w',
      capabilities: ['operations-readiness:read'],
    })
    const unavailable = await handlePlatformWorkerOperationsReadinessRequest(request(), {
      verify,
      resolve: vi.fn().mockRejectedValue(new Error('unavailable')),
    })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: 'OPERATIONS_READINESS_UNAVAILABLE' })

    const auditFailure = await handlePlatformWorkerOperationsReadinessRequest(request(), {
      verify,
      resolve: vi.fn().mockResolvedValue({
        status: 'ready',
        queue: { live: { status: 'unavailable' } },
      }),
      audit: vi.fn().mockRejectedValue(new Error('audit unavailable')),
    })
    expect(auditFailure.status).toBe(503)
  })
})
