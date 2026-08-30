import { describe, expect, it, vi } from 'vitest'

import { handleAgentBridgeHttpRequest } from './http'

const secret = `pf_mcp_${'a'.repeat(43)}`
const scope = { tenantId: 'tenant-1', venueId: 'venue-1' }
const credential = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['agent-runs:execute'],
}

function request(body: unknown, authorization = `Bearer ${secret}`) {
  return new Request('https://torchiko.test/api/agent-bridge/tenant-1/venue-1', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('agent bridge HTTP composition', () => {
  it('authenticates before dispatching a bounded method and returns no-store JSON', async () => {
    const verify = vi.fn().mockResolvedValue(credential)
    const claimTask = vi.fn().mockResolvedValue({ task: { id: 'run-1', costE8Usd: 0n } })
    const response = await handleAgentBridgeHttpRequest(
      request({
        method: 'claimTask',
        params: { sessionId: crypto.randomUUID(), venueId: 'venue-1' },
      }),
      scope,
      { verify, registry: { claimTask } as never },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(await response.json()).toEqual({
      ok: true,
      result: { task: { id: 'run-1', costE8Usd: '0' } },
    })
    expect(verify).toHaveBeenCalledWith({ ...scope, plaintext: secret })
    expect(claimTask).toHaveBeenCalledWith(expect.anything(), { credential })
  })

  it('routes prospect tool calls only after bridge credential verification', async () => {
    const verify = vi.fn().mockResolvedValue(credential)
    const callProspectTool = vi.fn().mockResolvedValue({ id: 'draft-1' })
    const response = await handleAgentBridgeHttpRequest(
      request({ method: 'callProspectTool', params: { opaque: true } }),
      scope,
      { verify, registry: { callProspectTool } as never },
    )
    expect(response.status).toBe(200)
    expect(callProspectTool).toHaveBeenCalledWith({ opaque: true }, { credential })
  })

  it('routes operational tool calls only after bridge credential verification', async () => {
    const verify = vi.fn().mockResolvedValue(credential)
    const callOperationalTool = vi.fn().mockResolvedValue({ structuredContent: { kind: 'read' } })
    const response = await handleAgentBridgeHttpRequest(
      request({ method: 'callOperationalTool', params: { toolName: 'pathfinder.read' } }),
      scope,
      { verify, registry: { callOperationalTool } as never },
    )
    expect(response.status).toBe(200)
    expect(callOperationalTool).toHaveBeenCalledWith(
      { toolName: 'pathfinder.read' },
      { credential },
    )
  })

  it('rejects missing authentication before reading or dispatching the body', async () => {
    const verify = vi.fn()
    const response = await handleAgentBridgeHttpRequest(
      request({ method: 'claimTask', params: {} }, ''),
      scope,
      { verify, registry: {} as never },
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ ok: false, error: { code: 'UNAUTHORIZED' } })
    expect(verify).not.toHaveBeenCalled()
  })

  it('bounds body size and never reflects secrets or internal operation errors', async () => {
    const verify = vi.fn().mockResolvedValue(credential)
    const oversized = new Request('https://torchiko.test/bridge', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-length': '131073' },
      body: '{}',
    })
    const bounded = await handleAgentBridgeHttpRequest(oversized, scope, {
      verify,
      registry: {} as never,
    })
    expect(bounded.status).toBe(400)
    expect(await bounded.json()).toEqual({ ok: false, error: { code: 'BODY_TOO_LARGE' } })

    const invalidMethod = `SECRET_SENTINEL_${secret}`
    const invalidEnvelope = await handleAgentBridgeHttpRequest(
      request({ method: invalidMethod, params: {} }),
      scope,
      { verify, registry: {} as never },
    )
    expect(invalidEnvelope.status).toBe(400)
    const invalidSerialized = JSON.stringify(await invalidEnvelope.json())
    expect(invalidSerialized).toBe('{"ok":false,"error":{"code":"INVALID_REQUEST"}}')
    expect(invalidSerialized).not.toContain(invalidMethod)

    const failTask = vi.fn().mockRejectedValue(new Error(`SECRET_SENTINEL ${secret}`))
    const failed = await handleAgentBridgeHttpRequest(
      request({ method: 'failTask', params: {} }),
      scope,
      { verify, registry: { failTask } as never },
    )
    expect(failed.status).toBe(409)
    const serialized = JSON.stringify(await failed.json())
    expect(serialized).toBe('{"ok":false,"error":{"code":"BRIDGE_OPERATION_REJECTED"}}')
    expect(serialized).not.toContain(secret)
  })

  it('rate-limits before performing expensive credential verification', async () => {
    const verify = vi.fn()
    const response = await handleAgentBridgeHttpRequest(
      request({ method: 'claimTask', params: {} }),
      scope,
      { verify, registry: {} as never, allowAttempt: () => false },
    )
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ ok: false, error: { code: 'RATE_LIMITED' } })
    expect(verify).not.toHaveBeenCalled()
  })
})
