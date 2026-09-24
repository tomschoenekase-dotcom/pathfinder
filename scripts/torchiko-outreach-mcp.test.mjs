import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createOutreachMcp, outreachBridgeStatus, outreachBridgeEnvNames, outreachMcpCodexArgs } from './lib/torchiko-outreach-mcp.mjs'
const root = path.resolve(import.meta.dirname, '..')
const env = () => ({ TORCHIKO_AGENT_BRIDGE_URL: 'http://127.0.0.1:1/api/agent-bridge/SYN-TENANT/SYN-VENUE',
  TORCHIKO_AGENT_BRIDGE_SECRET: `pf_mcp_${'A'.repeat(43)}`, TORCHIKO_AGENT_BRIDGE_VENUE_ID: 'SYN-VENUE',
  TORCHIKO_OUTREACH_SESSION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', TORCHIKO_OUTREACH_RUN_ID: 'SYN-RUN',
  TORCHIKO_OUTREACH_LEASE_TOKEN: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
const request = (name, args = {}) => ({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: args } })
const body = response => JSON.parse(response.result.content[0].text)
test('local discovery exposes only selected native preparation tools and an honest configuration hold', async () => {
  const adapter = await createOutreachMcp({ root, env: {}, fetchImpl: async () => { assert.fail('No HTTP during discovery') } })
  const names = adapter.tools.map(tool => tool.name)
  for (const name of ['read_outreach_review', 'prepare_native_writer', 'import_native_writer_result', 'read_outreach_cohort'])
    assert.ok(names.includes(`torchiko.prospects.${name}`))
  assert.ok(!names.some(name => /send|approve|save_outreach_draft|queue|lifecycle/u.test(name)))
  const status = body(await adapter.handle(request('torchiko_outreach_status')))
  assert.equal(status.state, 'AUTHENTICATED_NATIVE_BRIDGE_NOT_CONFIGURED')
  assert.equal(status.authenticatedNativeCallProven, false); assert.equal(status.missingEnvironmentNames.length, 4)
  assert.ok(!status.missingEnvironmentNames.some(name => /SESSION_ID|LEASE_TOKEN/u.test(name)))
  assert.match(status.operatorAction, /Activate bridge credential/)
  assert.equal(body(await adapter.handle(request('torchiko.prospects.read_venue', { venueId: 'v' }))).error, 'AUTHENTICATED_NATIVE_BRIDGE_NOT_CONFIGURED')
  assert.equal(body(await adapter.handle(request('send_email'))).error, 'OUTREACH_TOOL_NOT_ALLOWED')
})
test('exact existing HTTP envelope uses trusted run references and secret only in its Bearer header', async () => {
  let count = 0
  const input = { venueId: 'SYN-PROSPECT' }, settings = env()
  const adapter = await createOutreachMcp({ root, env: settings, fetchImpl: async (url, options) => {
    count++; assert.equal(url, settings.TORCHIKO_AGENT_BRIDGE_URL)
    assert.equal(options.headers.authorization, `Bearer ${settings.TORCHIKO_AGENT_BRIDGE_SECRET}`)
    assert.equal(options.redirect, 'error'); assert.ok(options.signal)
    assert.ok(!options.body.includes(settings.TORCHIKO_AGENT_BRIDGE_SECRET))
    const envelope = JSON.parse(options.body)
    assert.equal(envelope.method, 'callProspectTool'); assert.deepEqual(envelope.params.arguments, input)
    assert.equal(envelope.params.sessionId, settings.TORCHIKO_OUTREACH_SESSION_ID)
    assert.equal(envelope.params.runId, 'SYN-RUN'); assert.equal(envelope.params.venueId, 'SYN-VENUE')
    return Response.json({ ok: true, result: { synthetic: true, nativeRow: input.venueId, SEND_AUTHORIZED: false } })
  } })
  const result = await adapter.handle(request('torchiko.prospects.read_venue', input))
  assert.equal(body(result).nativeRow, 'SYN-PROSPECT'); assert.equal(count, 1)
  assert.ok(!JSON.stringify(result).includes(settings.TORCHIKO_AGENT_BRIDGE_SECRET))
})
test('forged, cross-route, credential-bearing and remote plaintext targets never make HTTP calls', async () => {
  for (const patch of [
    { TORCHIKO_AGENT_BRIDGE_URL: 'http://example.invalid/api/agent-bridge/SYN-TENANT/SYN-VENUE' },
    { TORCHIKO_AGENT_BRIDGE_URL: 'https://example.invalid/api/agent-bridge/SYN-TENANT/OTHER' },
    { TORCHIKO_AGENT_BRIDGE_URL: 'https://name:secret@example.invalid/api/agent-bridge/SYN-TENANT/SYN-VENUE' },
    { TORCHIKO_AGENT_BRIDGE_URL: 'https://example.invalid/api/agent-bridge/SYN-TENANT/SYN-VENUE?token=value' },
    { TORCHIKO_OUTREACH_SESSION_ID: 'fabricated' }, { TORCHIKO_AGENT_BRIDGE_SECRET: 'not-issued' },
  ]) {
    const adapter = await createOutreachMcp({ root, env: { ...env(), ...patch }, fetchImpl: async () => { assert.fail('Unusable target reached HTTP') } })
    assert.equal((await adapter.handle(request('torchiko.prospects.read_venue', {}))).result.isError, true)
  }
})
test('unknown, rejected, oversized and reflected-secret responses remain bounded non-leaking holds', async () => {
  for (const fetchImpl of [
    async () => { throw Error(`Sensitive internal message ${env().TORCHIKO_AGENT_BRIDGE_SECRET}`) },
    async () => new Response('sensitive detail', { status: 401 }),
    async () => Response.json({ ok: true, result: 'x'.repeat(1024 * 1024 + 1) }),
    async () => Response.json({ ok: true, result: env().TORCHIKO_AGENT_BRIDGE_SECRET }),
  ]) {
    const adapter = await createOutreachMcp({ root, env: env(), fetchImpl })
    const result = await adapter.handle(request('torchiko.prospects.read_venue', {}))
    assert.equal(result.result.isError, true)
    assert.ok(!JSON.stringify(result).includes(env().TORCHIKO_AGENT_BRIDGE_SECRET))
  }
})
test('native import retains its exact model result before the first uncertain network request', async () => {
  const operations = [], result = { originalModelPayload: 'synthetic transport-only fixture' }
  const adapter = await createOutreachMcp({ root, env: env(), retainResult: async value => { assert.strictEqual(value, result); operations.push('retain') },
    fetchImpl: async () => { operations.push('request'); throw Error('Simulated lost response') } })
  const response = await adapter.handle(request('torchiko.prospects.import_native_writer_result', { result }))
  assert.deepEqual(operations, ['retain', 'request'])
  assert.equal(body(response).error, 'NATIVE_BRIDGE_OUTCOME_UNKNOWN_RECONCILE_EXACT_REQUEST')
  const held = await createOutreachMcp({ root, env: env(), retainResult: async () => { throw Error('Disk unavailable') },
    fetchImpl: async () => assert.fail('Unretained payload reached the network') })
  assert.equal((await held.handle(request('torchiko.prospects.import_native_writer_result', { result }))).result.isError, true)
})
test('launch-scoped configuration contains only command, args and environment names, never credentials or approval weakening', () => {
  const args = outreachMcpCodexArgs(root), text = JSON.stringify(args)
  assert.ok(text.includes('mcp_servers.torchiko_outreach.command'))
  assert.ok(text.includes('TORCHIKO_AGENT_BRIDGE_SECRET')); assert.ok(!text.includes(env().TORCHIKO_AGENT_BRIDGE_SECRET))
  assert.ok(!/approval_mode|dangerously|config\.toml/u.test(text))
  assert.equal(outreachBridgeStatus(env()).state, 'CONFIGURED_NOT_AUTHENTICATED')
})
test('a fresh actual stdio process negotiates MCP, lists tools and returns status without stdout noise', () => {
  const cleanEnv = { ...process.env }; for (const name of outreachBridgeEnvNames) delete cleanEnv[name]
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-acceptance', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    request('torchiko_outreach_status'),
  ].map(JSON.stringify).join('\n') + '\n'
  const child = spawnSync(process.execPath, [path.join(root, 'scripts/torchiko-outreach-mcp.mjs')], {
    cwd: root, env: cleanEnv, encoding: 'utf8', windowsHide: true, timeout: 15000, input, maxBuffer: 2_000_000 })
  assert.equal(child.status, 0); assert.equal(child.stderr, '')
  const responses = child.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(responses.length, 3); assert.equal(responses[0].result.protocolVersion, '2025-06-18')
  assert.ok(responses[1].result.tools.length >= 20)
  assert.equal(body(responses[2]).state, 'AUTHENTICATED_NATIVE_BRIDGE_NOT_CONFIGURED')
})
test('local compiler/recovery tools dispatch without shell, network or manufactured native authority', async () => {
  const exact = { syntheticTransportFixture: true }, operations = []
  const adapter = await createOutreachMcp({ root, env: {}, fetchImpl: async () => assert.fail('Local helper used HTTP'),
    compileResult: (task, candidate, identity) => { assert.deepEqual([task, candidate, identity], [{ task: true }, { original: true }, 'SYNTHETIC-ONLY']); operations.push('compile'); return exact },
    retainResult: async result => { assert.strictEqual(result, exact); operations.push('retain'); return { sha256: 'a'.repeat(64) } },
    recoverResult: async selected => ({ selected, result: exact, nativeFreshnessProven: false, SEND_AUTHORIZED: false }) })
  const compiled = body(await adapter.handle(request('torchiko_outreach_compile', { task: { task: true }, candidate: { original: true }, modelIdentity: 'SYNTHETIC-ONLY' })))
  assert.deepEqual(operations, ['compile', 'retain']); assert.deepEqual(compiled.result, exact); assert.equal(compiled.nativeImportPerformed, false)
  const recovered = body(await adapter.handle(request('torchiko_outreach_recover_result', { taskId: `writer-task_${'b'.repeat(64)}`, sha256: 'a'.repeat(64) })))
  assert.equal(recovered.nativeFreshnessProven, false)
  assert.equal((await adapter.handle(request('torchiko_outreach_recover_result', { path: 'C:/outside' }))).result.isError, true)
})
test('a fresh installed-route launch with missing native authority stops before Codex discovery or model execution', () => {
  const cleanEnv = { ...process.env }; for (const name of outreachBridgeEnvNames) delete cleanEnv[name]
  // Making LOCALAPPDATA unusable distinguishes native-admission preflight from
  // the later installed-binary discovery path without mocking a model process.
  cleanEnv.LOCALAPPDATA = 'not-an-absolute-installed-binary-path'
  const child = spawnSync(process.execPath, [path.join(root, 'scripts/torchiko-outreach-codex.mjs'), 'start'], {
    cwd: root, env: cleanEnv, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(child.status, 1); assert.equal(child.stdout, '')
  const error = JSON.parse(child.stderr)
  assert.equal(error.error, 'AUTHENTICATED_NATIVE_BRIDGE_NOT_CONFIGURED')
  assert.equal(error.SEND_AUTHORIZED, false); assert.match(error.operatorAction, /Activate bridge credential/)
})
