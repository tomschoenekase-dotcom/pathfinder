import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { compileNativeOutreachResult } from './torchiko-outreach-result.mjs'
import { createOutreachConnection, outreachConnectionConfig, outreachBridgeEnvNames, outreachRequiredEnvNames } from './torchiko-outreach-connection.mjs'
export { outreachBridgeEnvNames } from './torchiko-outreach-connection.mjs'

const readNames = ['search_venues', 'read_venue', 'explain_venue', 'read_data_health', 'get_intelligence',
  'list_outreach_cohorts', 'preview_outreach_cohort', 'read_outreach_cohort', 'read_outreach_review',
  'read_native_writer_task', 'read_selected_reply_content', 'read_physical_geography', 'search_geography_records']
const writeNames = ['append_venue_evidence', 'prepare_native_writer', 'import_native_writer_result',
  'reserve_outreach_cohort', 'claim_outreach_window', 'checkpoint_outreach_member', 'ask_operator']
const allowed = new Set([...readNames, ...writeNames].map(name => `torchiko.prospects.${name}`))
const hold = code => Object.assign(new Error(code), { code })
const content = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError })

export function outreachBridgeStatus(env = process.env) {
  let state = 'CONFIGURED_NOT_AUTHENTICATED', config
  try { config = outreachConnectionConfig(env) } catch (error) { state = error.code }
  return { schema: 'torchiko.outreach-mcp-status/1', state,
    missingEnvironmentNames: outreachRequiredEnvNames.filter(name => !env[name]),
    authenticatedNativeCallProven: false, ownsSessionOrLeaseLifecycle: Boolean(config?.managed),
    operatorAction: state === 'CONFIGURED_NOT_AUTHENTICATED' ? null :
      'After the synthetic HTTP acceptance passes and the private tenant/venue/run references are admitted, the platform operator must select that exact venue-scoped MCP credential at /admin/clients/<admitted-tenant-id>/credentials and confirm Activate bridge credential. This checkout has no admitted live identity; do not invent one. Session and lease IDs are obtained from the native owner, not entered by the operator.',
    source: 'Existing /api/agent-bridge/<tenant>/<venue> callProspectTool owner; no new CRM, credentials or grants.',
    sender: 'tomschoenekase@torchiko.com', SEND_AUTHORIZED: false }
}
export function outreachMcpCodexArgs(root) {
  const entries = { command: process.execPath, args: [path.join(root, 'scripts/torchiko-outreach-mcp.mjs')], cwd: root,
    env_vars: outreachBridgeEnvNames, enabled: true, startup_timeout_sec: 10, tool_timeout_sec: 35 }
  return Object.entries(entries).flatMap(([key, value]) => ['-c', `mcp_servers.torchiko_outreach.${key}=${JSON.stringify(value)}`])
}

/** Thin transport adapter. Native credentials/run/grants remain the existing
 * bridge's authority; only the foreground session and selected lease are owned. */
export async function createOutreachMcp({ root, env = process.env, fetchImpl = globalThis.fetch, retainResult,
  recoverResult, compileResult = compileNativeOutreachResult } = {}) {
  const connection = createOutreachConnection({ env, fetchImpl })
  const contracts = JSON.parse(await readFile(path.join(root, 'packages/api/src/prospect-agent/tool-contracts.json'), 'utf8'))
  const tools = [{ name: 'torchiko_outreach_status', description: 'Read configuration holds and this process’s already-observed native lifecycle state. This status call itself does not access CRM, test credentials or disclose secret values.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'torchiko_outreach_compile', description: 'Mechanically compile your original native-task-bound model text and retain exact retry bytes locally. Does not generate prose, authenticate CRM, import a draft or approve sending.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['task', 'candidate', 'modelIdentity'],
        properties: { task: { type: 'object' }, candidate: { type: 'object', description: 'torchiko.codex-outreach-text/1 original fragments.' }, modelIdentity: { type: 'string', minLength: 1, maxLength: 191 } } },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    { name: 'torchiko_outreach_recover_result', description: 'Locate retry artifacts for one exact native task, or read one unchanged result by task and SHA-256. Local bytes do not prove current native freshness or authority.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'],
        properties: { taskId: { type: 'string', pattern: '^writer-task_[a-f0-9]{64}$' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  ...[...allowed].map(name => {
    const contract = contracts.tools[name]
    if (!contract?.inputSchema || contract.inputSchema.type !== 'object') throw hold('NATIVE_TOOL_CONTRACT_UNAVAILABLE')
    return { name, description: `Native no-send ${name.split('.').at(-1)}. Requires an already authorized live native bridge run; schema discovery grants no access.`,
      inputSchema: contract.inputSchema, annotations: { readOnlyHint: readNames.includes(name.split('.').at(-1)),
        destructiveHint: false, openWorldHint: true } }
  })]
  async function call(name, args) {
    if (name === 'torchiko_outreach_status') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw hold('INVALID_STATUS_ARGUMENTS')
      return content({ ...outreachBridgeStatus(env), ...connection.status() })
    }
    if (name === 'torchiko_outreach_compile') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['task', 'candidate', 'modelIdentity'].includes(key))) throw hold('INVALID_COMPILER_ARGUMENTS')
      if (!retainResult) throw hold('EXACT_RETRY_RETENTION_UNAVAILABLE')
      const result = compileResult(args.task, args.candidate, args.modelIdentity), artifact = await retainResult(result)
      return content({ result, artifact, nativeImportPerformed: false, SEND_AUTHORIZED: false })
    }
    if (name === 'torchiko_outreach_recover_result') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['taskId', 'sha256'].includes(key))) throw hold('INVALID_RECOVERY_ARGUMENTS')
      if (!recoverResult) throw hold('EXACT_RETRY_RETENTION_UNAVAILABLE')
      return content(await recoverResult(args))
    }
    if (!allowed.has(name)) throw hold('OUTREACH_TOOL_NOT_ALLOWED')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw hold('INVALID_NATIVE_TOOL_ARGUMENTS')
    outreachConnectionConfig(env)
    if (name === 'torchiko.prospects.import_native_writer_result') {
      if (!retainResult) throw hold('EXACT_RETRY_RETENTION_UNAVAILABLE')
      await retainResult(args.result)
    }
    return content(await connection.callTool(name, args))
  }
  return { tools, close: () => connection.close(), async handle(request) {
    const id = request?.id ?? null
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string')
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request' } }
    if (!Object.hasOwn(request, 'id')) return null
    try {
      let result
      if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'torchiko-outreach-native-bridge', version: '1.0.0' },
        instructions: 'No-send preparation only. Local status/schema discovery never authenticates a native CRM run. Preserve exact result bytes and native approval boundaries.' }
      else if (request.method === 'ping') result = {}
      else if (request.method === 'tools/list') result = { tools }
      else if (request.method === 'tools/call') result = await call(request.params?.name, request.params?.arguments ?? {})
      else return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }
      return { jsonrpc: '2.0', id, result }
    } catch (error) { return { jsonrpc: '2.0', id, result: content({ error: error.code ?? 'OUTREACH_ADAPTER_HELD', SEND_AUTHORIZED: false }, true) } }
  } }
}
