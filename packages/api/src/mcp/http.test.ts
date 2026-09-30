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
    headers: {
      authorization,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
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

  it('negotiates the requested supported protocol version on initialize', async () => {
    const result = await handleMcpHttpRequest(
      request({
        jsonrpc: '2.0',
        id: 'initialize-1',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'Codex test client', version: '1.0.0' },
        },
      }),
      scope,
      {
        verify: vi.fn().mockResolvedValue(credential),
        registry: { listTools: vi.fn(), callTool: vi.fn() } as never,
      },
    )
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      id: 'initialize-1',
      result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } } },
    })
  })

  it('serves a stateless Streamable HTTP initialize, list, and call sequence', async () => {
    const verify = vi.fn().mockResolvedValue(credential)
    const registry = {
      listTools: vi.fn().mockReturnValue([{ name: 'torchiko.venues.list' }]),
      callTool: vi.fn().mockResolvedValue({
        resultType: 'complete',
        structuredContent: { kind: 'venues', summary: '1 venue', data: { count: 1 } },
        content: [{ type: 'text', text: '{"count":1}' }],
        isError: false,
      }),
    }
    const dispatch = (body: unknown) =>
      handleMcpHttpRequest(request(body), scope, { verify, registry: registry as never })

    const initialized = await dispatch({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'CLI', version: '1' },
      },
    })
    const initializedBody = (await initialized.json()) as { result: { protocolVersion?: string } }
    expect(initializedBody.result.protocolVersion).toBe('2025-11-25')
    const ready = await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(ready.status).toBe(202)
    expect(await ready.text()).toBe('')

    const listed = await dispatch({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} })
    const listedBody = (await listed.json()) as { result: { tools: unknown[] } }
    expect(listedBody.result.tools).toEqual([{ name: 'torchiko.venues.list' }])
    const called = await dispatch({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'torchiko.venues.list', arguments: { clientId: 'tenant_1' } },
    })
    const calledBody = (await called.json()) as { result: { structuredContent: unknown } }
    expect(calledBody.result.structuredContent).toEqual({
      kind: 'venues',
      summary: '1 venue',
      data: { count: 1 },
    })
    expect(registry.callTool).toHaveBeenCalledWith(
      'torchiko.venues.list',
      { clientId: 'tenant_1' },
      { credential },
    )
  })

  it('supports a tenant route with a client-only verified scope', async () => {
    const clientCredential = { ...credential, venueIds: [] }
    const verify = vi.fn().mockResolvedValue(clientCredential)
    const registry = {
      listTools: vi.fn().mockReturnValue([{ name: 'torchiko.venues.list' }]),
      callTool: vi.fn(),
    }
    const result = await handleMcpHttpRequest(
      request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      { tenantId: 'tenant_1' },
      { verify, registry: registry as never },
    )
    expect(result.status).toBe(200)
    expect(verify).toHaveBeenCalledWith({ tenantId: 'tenant_1', plaintext: secret })
    expect(await result.json()).toMatchObject({
      result: { tools: [{ name: 'torchiko.venues.list' }] },
    })
  })

  it('rejects malformed route scopes before authentication', async () => {
    const verify = vi.fn()
    const result = await handleMcpHttpRequest(
      request({}),
      { tenantId: 'tenant_1', extra: true },
      {
        verify,
      },
    )
    expect(result.status).toBe(404)
    expect(verify).not.toHaveBeenCalled()
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
      headers: {
        authorization: `Bearer ${secret}`,
        'content-length': '131073',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    })
    const bounded = await handleMcpHttpRequest(oversized, scope, {
      verify: vi.fn().mockResolvedValue(credential),
      registry: registry as never,
    })
    expect(bounded.status).toBe(400)
    expect(registry.listTools).not.toHaveBeenCalled()
  })

  it('requires the Streamable HTTP JSON and event-stream Accept types', async () => {
    const invalidMediaRequest = new Request('https://torchiko.test/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
    })
    const result = await handleMcpHttpRequest(invalidMediaRequest, scope, {
      verify: vi.fn(),
    })
    expect(result.status).toBe(406)
  })

  it('rejects cross-origin requests before credential verification', async () => {
    const verify = vi.fn()
    const result = await handleMcpHttpRequest(
      new Request('https://torchiko.test/mcp/tenant_1/venue_1', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          origin: 'https://attacker.test',
        },
        body: '{}',
      }),
      scope,
      { verify },
    )
    expect(result.status).toBe(403)
    expect(verify).not.toHaveBeenCalled()
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
