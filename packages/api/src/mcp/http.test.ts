import { describe, expect, it, vi } from 'vitest'

import { handleMcpHttpRequest } from './http'

const secret = `pf_mcp_${'a'.repeat(43)}`
const scope = { tenantId: 'tenant_1', venueId: 'venue_1' }
const credential = {
  credentialId: 'credential_1',
  tenantId: 'tenant_1',
  clientId: 'tenant_1',
  venueIds: ['venue_1'],
  capabilities: ['accounts:read'],
}

function request(body: unknown, authorization = `Bearer ${secret}`) {
  return new Request('https://torchiko.test/mcp/tenant_1/venue_1', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('authenticated MCP HTTP transport', () => {
  it('authenticates before dispatch and returns standard JSON-RPC tool discovery', async () => {
    const verify = vi.fn().mockResolvedValue(credential)
    const registry = {
      listTools: vi.fn().mockReturnValue([{ name: 'torchiko.account.get_context' }]),
      callTool: vi.fn(),
    }
    const result = await handleMcpHttpRequest(
      request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      scope,
      { verify, registry: registry as never },
    )
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'torchiko.account.get_context' }] },
    })
    expect(verify).toHaveBeenCalledWith({ ...scope, plaintext: secret })
  })

  it('rejects unauthenticated and oversized requests before tool dispatch', async () => {
    const verify = vi.fn()
    const registry = { listTools: vi.fn(), callTool: vi.fn() }
    const unauthorized = await handleMcpHttpRequest(request({}, ''), scope, {
      verify,
      registry: registry as never,
    })
    expect(unauthorized.status).toBe(401)
    expect(verify).not.toHaveBeenCalled()

    const oversized = new Request('https://torchiko.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-length': '131073' },
      body: '{}',
    })
    const bounded = await handleMcpHttpRequest(oversized, scope, {
      verify: vi.fn().mockResolvedValue(credential),
      registry: registry as never,
    })
    expect(bounded.status).toBe(400)
    expect(registry.listTools).not.toHaveBeenCalled()
  })

  it('returns no body for MCP notifications', async () => {
    const result = await handleMcpHttpRequest(
      request({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      scope,
      {
        verify: vi.fn().mockResolvedValue(credential),
        registry: { listTools: vi.fn(), callTool: vi.fn() } as never,
      },
    )
    expect(result.status).toBe(202)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.text()).toBe('')
  })
})
