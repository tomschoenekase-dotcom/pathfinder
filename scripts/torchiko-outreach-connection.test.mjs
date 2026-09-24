import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutreachConnection, outreachConnectionConfig } from './lib/torchiko-outreach-connection.mjs'
const env = () => ({ TORCHIKO_AGENT_BRIDGE_URL: 'http://127.0.0.1:1/api/agent-bridge/SYN-TENANT/SYN-VENUE',
  TORCHIKO_AGENT_BRIDGE_SECRET: `pf_mcp_${'A'.repeat(43)}`, TORCHIKO_AGENT_BRIDGE_VENUE_ID: 'SYN-VENUE', TORCHIKO_OUTREACH_RUN_ID: 'SYN-RUN' })
const caps = ['prospects.read', 'prospects.native-writer', 'prospects.correspondence.read']
function fixture(overrides = {}) {
  const calls = [], cancelled = [], clock = { value: Date.now() }, settings = env()
  let scheduled
  const task = { id: 'SYN-RUN', venueId: 'SYN-VENUE', modelProvider: 'codex-bridge', modelName: 'gpt-6-sol',
    leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', leaseExpiresAt: new Date(clock.value + 90000).toISOString(),
    agent: { accessCapabilities: caps }, scope: { accessCapabilities: caps } }
  const connection = createOutreachConnection({ env: settings, now: () => clock.value,
    schedule: fn => { scheduled = fn; return 1 }, cancel: id => cancelled.push(id),
    fetchImpl: async (url, options) => {
      const { method, params } = JSON.parse(options.body); calls.push({ method, params })
      assert.equal(options.headers.authorization, `Bearer ${settings.TORCHIKO_AGENT_BRIDGE_SECRET}`)
      assert.equal(options.redirect, 'error')
      if (overrides[method]) return overrides[method](params)
      const result = method === 'claimTask' ? { task } : method === 'heartbeatTask' ? { leaseExpiresAt: task.leaseExpiresAt } :
        method === 'callProspectTool' ? { synthetic: true, SEND_AUTHORIZED: false } : { status: 'ONLINE' }
      return Response.json({ ok: true, result })
    } })
  return { connection, calls, cancelled, clock, task, tick: () => scheduled?.() }
}
test('foreground route gets its session and lease from native owners, never from model arguments', async () => {
  const f = fixture()
  assert.equal(outreachConnectionConfig(env()).managed, true)
  await Promise.all([f.connection.connect(), f.connection.connect()])
  assert.deepEqual(f.calls.map(c => c.method), ['register', 'registerWorker', 'claimTask', 'heartbeatSession', 'heartbeatTask', 'heartbeatWorker'])
  assert.equal(f.calls[2].params.runId, 'SYN-RUN')
  assert.equal(f.connection.status().authenticatedNativeCallProven, false)
  await f.connection.callTool('torchiko.prospects.read_venue', { venueId: 'SYN-PROSPECT' })
  assert.equal(f.connection.status().authenticatedNativeCallProven, true)
  const safe = JSON.stringify(f.connection.status())
  assert.ok(!safe.includes(f.task.leaseToken)); assert.ok(!safe.includes(env().TORCHIKO_AGENT_BRIDGE_SECRET))
  await f.connection.close(); await f.connection.close()
  assert.equal(f.calls.filter(c => c.method === 'failTask').length, 1)
  assert.ok(!f.calls.some(c => /complete|send|approve/i.test(c.method)))
})
test('missing authority, rejected activation and absent selected run fail closed without claiming unrelated work', async () => {
  const empty = createOutreachConnection({ env: {}, fetchImpl: async () => assert.fail('No configuration should reach HTTP') })
  await assert.rejects(empty.connect(), /AUTHENTICATED_NATIVE_BRIDGE_NOT_CONFIGURED/)
  for (const overrides of [{ register: () => new Response('', { status: 401 }) },
    { claimTask: () => Response.json({ ok: true, result: { task: null } }) }]) {
    const f = fixture(overrides)
    await assert.rejects(f.connection.connect())
    const before = f.calls.length
    await assert.rejects(f.connection.connect())
    assert.equal(f.calls.length, before)
    assert.equal(f.connection.status().authenticatedNativeCallProven, false)
    await f.connection.close()
  }
})
test('a wrong claim binding is never passed to native prospect tools', async () => {
  const f = fixture(); f.task.id = 'ANOTHER-RUN'
  await assert.rejects(f.connection.callTool('torchiko.prospects.read_venue', {}), /CLAIM_BINDING_REJECTED/)
  assert.ok(!f.calls.some(c => c.method === 'callProspectTool'))
  await f.connection.close()
})
test('heartbeat failures and elapsed leases stop use rather than silently reconnecting or fabricating a new lease', async () => {
  const f = fixture(); await f.connection.connect(); f.clock.value += 90001
  await assert.rejects(f.connection.callTool('torchiko.prospects.read_venue', {}), /LEASE_EXPIRED/)
  assert.ok(!f.calls.some(c => c.method === 'callProspectTool')); await f.connection.close()
  const g = fixture({ heartbeatTask: () => new Response('', { status: 409 }) })
  await assert.rejects(g.connection.connect(), /SCOPE_LEASE_OR_REQUEST_HELD/)
  await assert.rejects(g.connection.callTool('torchiko.prospects.read_venue', {}))
  assert.ok(!g.calls.some(c => c.method === 'callProspectTool')); await g.connection.close()
})
test('partial supplied lease references are rejected instead of mixed with newly created authority', () => {
  assert.throws(() => outreachConnectionConfig({ ...env(), TORCHIKO_OUTREACH_SESSION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))
})
test('only a confirmed native immutable receipt permits successful no-send run settlement', async () => {
  const f = fixture({ callProspectTool: () => Response.json({ ok: true, result: {
    receiptId: 'SYN-RECEIPT', draftId: 'SYN-DRAFT', pendingOperatorReview: true, SEND_AUTHORIZED: false } }) })
  await f.connection.callTool('torchiko.prospects.import_native_writer_result', {})
  await f.connection.close()
  assert.equal(f.calls.filter(c => c.method === 'completeTask').length, 1)
  assert.ok(!f.calls.some(c => c.method === 'failTask'))
  assert.equal(f.calls.at(-1).params.costStatus, 'UNREPORTED')
})
test('native cancellation stops further prospect activity', async () => {
  const f = fixture({ heartbeatTask: () => Response.json({ ok: true, result: { cancelRequested: true } }) })
  await assert.rejects(f.connection.connect(), /CANCEL_REQUESTED/)
  await assert.rejects(f.connection.callTool('torchiko.prospects.read_venue', {}))
  assert.ok(!f.calls.some(c => c.method === 'callProspectTool'))
  await f.connection.close()
})
test('a later uncertain import never settles using an older confirmed receipt', async () => {
  let count = 0
  const f = fixture({ callProspectTool: () => {
    if (++count > 1) throw new Error('Synthetic connection reset after possible commit')
    return Response.json({ ok: true, result: { receiptId: 'SYN-OLD-RECEIPT', draftId: 'SYN-OLD-DRAFT',
      pendingOperatorReview: true, SEND_AUTHORIZED: false } })
  } })
  await f.connection.callTool('torchiko.prospects.import_native_writer_result', {})
  await assert.rejects(f.connection.callTool('torchiko.prospects.import_native_writer_result', {}), /OUTCOME_UNKNOWN/)
  await f.connection.close()
  assert.ok(!f.calls.some(c => c.method === 'completeTask'))
  assert.equal(f.calls.filter(c => c.method === 'failTask').length, 1)
})
test('a valid claimed lease with an inadequate writer grant is released without completing or calling a writer', async () => {
  const f = fixture(); f.task.scope = { accessCapabilities: [] }
  await assert.rejects(f.connection.connect(), /WRITER_GRANT_REQUIRED/)
  await f.connection.close()
  assert.equal(f.calls.filter(c => c.method === 'failTask').length, 1)
  assert.ok(!f.calls.some(c => ['completeTask', 'callProspectTool'].includes(c.method)))
})
