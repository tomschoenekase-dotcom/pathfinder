import { describe, expect, it, vi } from 'vitest'

import { dispatchMcpJsonRpc } from './json-rpc'

const credential = {
  credentialId: 'credential_1',
  tenantId: 'tenant_1',
  clientId: 'tenant_1',
  venueIds: ['venue_1'],
  capabilities: ['accounts:read'],
} as const

function registry() {
  return {
    listTools: vi.fn().mockReturnValue([
      {
        name: 'torchiko.account.get_context',
        description: 'Compact account context',
        inputSchema: { type: 'object' },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      structuredContent: { kind: 'account', summary: 'Museum Y', data: {} },
      content: [{ type: 'text', text: '{}' }],
      isError: false,
    }),
  }
}

describe('MCP JSON-RPC dispatcher', () => {
  it('negotiates, discovers tool schemas, and calls through the existing governed registry', async () => {
    const target = registry()
    const initialized = await dispatchMcpJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { credential: credential as never },
      target as never,
    )
    expect(initialized).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { capabilities: { tools: { listChanged: false } } },
    })
    const listed = await dispatchMcpJsonRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { credential: credential as never },
      target as never,
    )
    expect(listed).toMatchObject({
      result: { tools: [{ name: 'torchiko.account.get_context' }] },
    })
    await dispatchMcpJsonRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'torchiko.account.get_context',
          arguments: { clientId: 'tenant_1', organizationId: 'org_1' },
        },
      },
      { credential: credential as never },
      target as never,
    )
    expect(target.callTool).toHaveBeenCalledWith(
      'torchiko.account.get_context',
      { clientId: 'tenant_1', organizationId: 'org_1' },
      { credential },
    )
  })

  it('returns standard method and parameter errors without leaking internals', async () => {
    const target = registry()
    await expect(
      dispatchMcpJsonRpc(
        { jsonrpc: '2.0', id: 'unknown', method: 'database.execute', params: {} },
        { credential: credential as never },
        target as never,
      ),
    ).resolves.toMatchObject({ error: { code: -32601, message: 'Method not found' } })
    await expect(
      dispatchMcpJsonRpc(
        { jsonrpc: '2.0', id: 'bad', method: 'tools/call', params: { arguments: {} } },
        { credential: credential as never },
        target as never,
      ),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } })
  })

  it('does not respond to notifications', async () => {
    await expect(
      dispatchMcpJsonRpc(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { credential: credential as never },
        registry() as never,
      ),
    ).resolves.toBeNull()
  })
})
