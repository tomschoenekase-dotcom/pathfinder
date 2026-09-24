import { randomUUID } from 'node:crypto'

export const outreachBridgeEnvNames = ['TORCHIKO_AGENT_BRIDGE_URL', 'TORCHIKO_AGENT_BRIDGE_SECRET',
  'TORCHIKO_AGENT_BRIDGE_VENUE_ID', 'TORCHIKO_OUTREACH_SESSION_ID', 'TORCHIKO_OUTREACH_RUN_ID', 'TORCHIKO_OUTREACH_LEASE_TOKEN']
export const outreachRequiredEnvNames = outreachBridgeEnvNames.filter(name =>
  !['TORCHIKO_OUTREACH_SESSION_ID', 'TORCHIKO_OUTREACH_LEASE_TOKEN'].includes(name))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
export const outreachHold = code => Object.assign(new Error(code), { code })

export function outreachConnectionConfig(env) {
  if (outreachRequiredEnvNames.some(name => !env[name])) throw outreachHold('AUTHENTICATED_NATIVE_BRIDGE_NOT_CONFIGURED')
  let url
  try { url = new URL(env.TORCHIKO_AGENT_BRIDGE_URL) } catch { throw outreachHold('INVALID_NATIVE_BRIDGE_TARGET') }
  const route = /^\/api\/agent-bridge\/([A-Za-z0-9_-]{1,191})\/([A-Za-z0-9_-]{1,191})$/u.exec(url.pathname)
  if (url.username || url.password || url.search || url.hash || !route || route[2] !== env.TORCHIKO_AGENT_BRIDGE_VENUE_ID ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    throw outreachHold('INVALID_NATIVE_BRIDGE_TARGET')
  const sessionId = env.TORCHIKO_OUTREACH_SESSION_ID, leaseToken = env.TORCHIKO_OUTREACH_LEASE_TOKEN
  if (!/^pf_mcp_[A-Za-z0-9_-]{43}$/u.test(env.TORCHIKO_AGENT_BRIDGE_SECRET) ||
      !/^[A-Za-z0-9_:-]{1,191}$/u.test(env.TORCHIKO_OUTREACH_RUN_ID) ||
      Boolean(sessionId) !== Boolean(leaseToken) ||
      (sessionId && (!uuid.test(sessionId) || !uuid.test(leaseToken))))
    throw outreachHold('INVALID_NATIVE_BRIDGE_REFERENCES')
  return { url: url.href, secret: env.TORCHIKO_AGENT_BRIDGE_SECRET, venueId: route[2],
    runId: env.TORCHIKO_OUTREACH_RUN_ID, sessionId, leaseToken, managed: !sessionId }
}

/** One bounded transport for both existing callProspectTool and its native lease
 * lifecycle. Secret and lease values never enter MCP tool responses or errors. */
export async function outreachHttpCall(config, method, params, fetchImpl = globalThis.fetch) {
  const body = JSON.stringify({ method, params })
  if (Buffer.byteLength(body) > 128 * 1024) throw outreachHold('NATIVE_REQUEST_TOO_LARGE')
  let response
  try { response = await fetchImpl(config.url, { method: 'POST', headers: {
    authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
    body, redirect: 'error', signal: AbortSignal.timeout(30000) }) }
  catch { throw outreachHold('NATIVE_BRIDGE_OUTCOME_UNKNOWN_RECONCILE_EXACT_REQUEST') }
  if (!response.ok) {
    await response.body?.cancel()
    throw outreachHold(response.status === 401 ? 'NATIVE_BRIDGE_AUTHENTICATION_HELD' :
      response.status === 409 ? 'NATIVE_BRIDGE_SCOPE_LEASE_OR_REQUEST_HELD' :
        'NATIVE_BRIDGE_UNAVAILABLE_RECONCILE_EXACT_REQUEST')
  }
  if (!response.body || !response.headers.get('content-type')?.includes('application/json'))
    throw outreachHold('NATIVE_BRIDGE_RESPONSE_UNAVAILABLE')
  const reader = response.body.getReader(), chunks = []; let bytes = 0
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 1024 * 1024) { await reader.cancel(); throw outreachHold('NATIVE_BRIDGE_RESPONSE_TOO_LARGE_NO_PARTIAL_REVIEW') }
      chunks.push(item.value)
    }
  } catch (error) { if (error.code) throw error; throw outreachHold('NATIVE_BRIDGE_OUTCOME_UNKNOWN_RECONCILE_EXACT_REQUEST') }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.includes(config.secret)) throw outreachHold('NATIVE_BRIDGE_SECRET_REFLECTION_HELD')
  let envelope
  try { envelope = JSON.parse(text) } catch { throw outreachHold('NATIVE_BRIDGE_INVALID_RESPONSE_RECONCILE_EXACT_REQUEST') }
  if (envelope.ok !== true || !Object.hasOwn(envelope, 'result')) throw outreachHold('NATIVE_BRIDGE_REJECTED')
  return envelope.result
}

/** Owns only the foreground process's session and selected native run lease.
 * No credential issue/activation, run creation, scheduler, writer or outbox. */
export function createOutreachConnection({ env = process.env, fetchImpl = globalThis.fetch,
  now = Date.now, schedule = (fn, ms) => setInterval(fn, ms), cancel = clearInterval } = {}) {
  let config, phase = 'NEW', failure = null, connecting = null, pulsing = null, timer,
    leaseExpiresAt = null, nativeCallProven = false, closing = null, confirmedImport = null
  try { config = outreachConnectionConfig(env) } catch (error) { failure = error.code; phase = 'HELD' }
  const workerKey = `outreach-${randomUUID()}`
  const modelName = 'gpt-6-sol'
  const stopTimer = () => { if (timer !== undefined) cancel(timer); timer = undefined }
  const hold = code => { failure = code; phase = 'HELD'; stopTimer(); return outreachHold(code) }
  const session = () => ({ venueId: config.venueId, sessionId: config.sessionId })
  const lease = () => ({ ...session(), runId: config.runId, leaseToken: config.leaseToken })
  const rpc = (method, params) => outreachHttpCall(config, method, params, fetchImpl)
  function status() {
    return { state: failure ?? (phase === 'NEW' ? 'CONFIGURED_NOT_AUTHENTICATED' : phase),
      ownsSessionOrLeaseLifecycle: Boolean(config?.managed), authenticatedNativeCallProven: nativeCallProven,
      sessionAuthenticated: phase === 'CONNECTED' && (config?.managed || nativeCallProven), leaseExpiresAt,
      selectedRunId: config?.runId ?? null, SEND_AUTHORIZED: false }
  }
  async function pulse() {
    if (pulsing) return pulsing
    if (phase !== 'CONNECTED') throw outreachHold(failure ?? 'NATIVE_BRIDGE_NOT_CONNECTED')
    if (config.managed && leaseExpiresAt !== null && now() >= Date.parse(leaseExpiresAt))
      throw hold('NATIVE_BRIDGE_LEASE_EXPIRED_REOPEN_SELECTED_RUN')
    pulsing = (async () => {
      try {
        await rpc('heartbeatSession', session())
        const beat = await rpc('heartbeatTask', lease())
        if (beat?.cancelRequested === true) throw outreachHold('NATIVE_BRIDGE_CANCEL_REQUESTED')
        if (config.managed) await rpc('heartbeatWorker', { workerKey, safeHealth: { noSend: true } })
        if (beat?.leaseExpiresAt) leaseExpiresAt = new Date(beat.leaseExpiresAt).toISOString()
      } catch (error) { throw hold(error.code ?? 'NATIVE_BRIDGE_HEARTBEAT_HELD') }
      finally { pulsing = null }
    })()
    return pulsing
  }
  async function connect() {
    if (connecting) return connecting
    if (phase === 'CONNECTED') return
    if (phase !== 'NEW') throw outreachHold(failure ?? 'NATIVE_BRIDGE_CLOSED')
    if (!config.managed) { phase = 'CONNECTED'; return }
    phase = 'CONNECTING'
    connecting = (async () => {
      try {
        config.sessionId = randomUUID()
        await rpc('register', { ...session(), provider: 'CODEX_SUBSCRIPTION', label: 'Foreground no-send outreach',
          runnerVersion: 'torchiko-outreach/2', supportedModels: [modelName] })
        await rpc('registerWorker', { workerKey, runtimeType: 'CODEX', label: 'Foreground no-send outreach',
          protocolVersion: 'mcp-2025-06-18', softwareVersion: 'torchiko-outreach/2',
          capabilities: ['agent-runs:execute'], agentRoles: ['OUTREACH'], safeHealth: { noSend: true } })
        const claimed = await rpc('claimTask', { ...session(), workerKey, runId: config.runId })
        const task = claimed?.task
        if (!task) throw outreachHold('NATIVE_BRIDGE_SELECTED_RUN_NOT_CLAIMABLE')
        if (task.id !== config.runId || task.venueId !== config.venueId || !uuid.test(task.leaseToken) ||
            task.modelProvider !== 'codex-bridge' || ![modelName, 'subscription-default'].includes(task.modelName) ||
            !Number.isFinite(Date.parse(task.leaseExpiresAt)) || Date.parse(task.leaseExpiresAt) <= now())
          throw outreachHold('NATIVE_BRIDGE_CLAIM_BINDING_REJECTED')
        // Once the native owner has returned a valid selected lease, retain it
        // privately so close() can release even a subsequently rejected grant.
        config.leaseToken = task.leaseToken; leaseExpiresAt = task.leaseExpiresAt
        const required = ['prospects.read', 'prospects.native-writer', 'prospects.correspondence.read']
        if (!required.every(cap => task.agent?.accessCapabilities?.includes(cap) && task.scope?.accessCapabilities?.includes(cap)))
          throw outreachHold('NATIVE_BRIDGE_WRITER_GRANT_REQUIRED')
        phase = 'CONNECTED'
        await pulse()
        timer = schedule(() => { void pulse().catch(() => {}) }, 25000)
        timer?.unref?.()
      } catch (error) { throw hold(error.code ?? 'NATIVE_BRIDGE_CONNECTION_HELD') }
      finally { connecting = null }
    })()
    return connecting
  }
  async function callTool(toolName, args) {
    await connect()
    if (phase !== 'CONNECTED') throw outreachHold(failure ?? 'NATIVE_BRIDGE_NOT_CONNECTED')
    if (config.managed && now() >= Date.parse(leaseExpiresAt)) throw hold('NATIVE_BRIDGE_LEASE_EXPIRED_REOPEN_SELECTED_RUN')
    if (['torchiko.prospects.prepare_native_writer', 'torchiko.prospects.import_native_writer_result'].includes(toolName))
      confirmedImport = null
    const result = await rpc('callProspectTool', { ...lease(), correlationId: randomUUID(), toolName, arguments: args })
    // Lease material belongs exclusively to this process, even if a server
    // accidentally includes it in a normal prospect tool's response.
    if (JSON.stringify(result)?.includes(config.leaseToken)) throw hold('NATIVE_BRIDGE_LEASE_REFLECTION_HELD')
    nativeCallProven = true
    if (toolName === 'torchiko.prospects.import_native_writer_result' &&
        typeof result?.receiptId === 'string' && result.receiptId.length > 0 && result.receiptId.length <= 191 &&
        typeof result?.draftId === 'string' && result.draftId.length > 0 && result.draftId.length <= 191 &&
        result.pendingOperatorReview === true && result.SEND_AUTHORIZED === false) {
      confirmedImport = { receiptId: result.receiptId, draftId: result.draftId,
        pendingOperatorReview: true, SEND_AUTHORIZED: false }
    }
    return result
  }
  async function close() {
    if (closing) return closing
    stopTimer()
    closing = (async () => {
      if (connecting) { try { await connecting } catch {} }
      stopTimer()
      if (pulsing) { try { await pulsing } catch {} }
      // Do not mark an uncertain draft complete. The existing native failure
      // owner retains attempt history and may requeue the SAME run for recovery.
      if (config?.managed && config.leaseToken) {
        try {
          if (confirmedImport) {
            await rpc('completeTask', { ...lease(),
              summary: 'Exact native writer receipt confirmed; immutable draft awaits operator review. No approval or send.',
              artifacts: [{ title: 'Native writer review receipt', type: 'json',
                content: JSON.stringify(confirmedImport) }],
              modelName, costE8Usd: '0', costStatus: 'UNREPORTED' })
          } else {
            await rpc('failTask', { ...lease(), errorCode: 'TASK_EXECUTOR_FAILED', retryable: true })
          }
        }
        catch { phase = 'CLOSED'; failure = 'NATIVE_BRIDGE_RELEASE_UNCONFIRMED_LEASE_WILL_EXPIRE'; return status() }
      }
      phase = 'CLOSED'; return status()
    })()
    return closing
  }
  return { status, connect, pulse, callTool, close }
}
