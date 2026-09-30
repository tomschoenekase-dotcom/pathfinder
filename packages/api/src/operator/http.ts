import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { db } from '@pathfinder/db'

import { writeOperatorAudit, writeOperatorAuditBestEffort, type OperatorDatabase } from './audit'
import {
  protectedResourceMetadataUrl,
  resolveOperatorConfig,
  type OperatorConfigResolution,
  type OperatorServerConfig,
} from './config'
import { OperatorCapabilityError, OperatorNotFoundError } from './grants'
import { verifyOperatorAccessToken, type VerifiedOperatorGrant } from './oauth'
import { OperatorProposalError } from './proposals'
import {
  createOperatorRegistry,
  defaultVenueRead,
  OperatorToolCallParams,
  OperatorUnknownToolError,
  type OperatorRegistry,
  type VenueReadService,
} from './registry'
import { argsHash } from './tokens'

const MAX_BODY_BYTES = 128 * 1024
const CALLS_PER_MINUTE_PER_GRANT = 120
const PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

export type OperatorMcpDependencies = Readonly<{
  resolveConfig?: () => OperatorConfigResolution
  database?: OperatorDatabase
  registry?: OperatorRegistry
  venueRead?: VenueReadService
  now?: () => Date
}>

function respond(
  status: number,
  body: unknown,
  requestId: string,
  extra: Record<string, string> = {},
) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...extra,
    },
  })
}

function unauthorized(config: OperatorServerConfig, requestId: string, invalidToken: boolean) {
  const challenge = [
    `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}"`,
    'scope="operator"',
    ...(invalidToken ? ['error="invalid_token"'] : []),
  ].join(', ')
  return respond(401, { error: invalidToken ? 'invalid_token' : 'unauthorized' }, requestId, {
    'www-authenticate': challenge,
  })
}

function hasValidOrigin(request: Request, config: OperatorServerConfig) {
  const origin = request.headers.get('origin')
  if (origin === null) return true
  // Browsers may only call from our own origin; server-side connectors send no Origin header.
  return origin === config.issuer
}

function acceptsMcpPost(request: Request) {
  const accept = (request.headers.get('accept') ?? '').toLowerCase()
  return (
    accept.includes('application/json') &&
    accept.includes('text/event-stream') &&
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
      'application/json'
  )
}

async function boundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new Error('BODY_TOO_LARGE')
  }
  if (!request.body) throw new Error('INVALID_JSON')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new Error('BODY_TOO_LARGE')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

const RpcRequest = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(191), z.number().int(), z.null()]).optional(),
    method: z.string().trim().min(1).max(191),
    params: z.unknown().optional(),
  })
  .strict()

type RpcId = string | number | null

function rpcError(id: RpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

function toolResult(structured: unknown, isError = false) {
  const payload = structured as Record<string, unknown>
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  }
}

function errorCode(error: unknown): string {
  if (error instanceof OperatorNotFoundError) return 'NOT_FOUND'
  if (error instanceof OperatorCapabilityError) return 'CAPABILITY_DENIED'
  if (error instanceof OperatorUnknownToolError) return 'UNKNOWN_TOOL'
  if (error instanceof OperatorProposalError) return error.code
  if (error instanceof z.ZodError) return 'INVALID_ARGUMENTS'
  return 'TOOL_FAILED'
}

function targetOf(args: Record<string, unknown>) {
  return {
    targetTenantId: typeof args.tenantId === 'string' ? args.tenantId.slice(0, 191) : null,
    targetVenueId: typeof args.venueId === 'string' ? args.venueId.slice(0, 191) : null,
  }
}

/**
 * Streamable-HTTP-compatible POST endpoint for the Dot. Authentication is an operator OAuth
 * access token bound to this exact resource; authority is the consented grant, re-read per call.
 * `_meta` approval claims are ignored: approvals exist only as server-side proposal state.
 */
export async function handleOperatorMcpRequest(
  request: Request,
  dependencies: OperatorMcpDependencies = {},
): Promise<Response> {
  const requestId = randomUUID()
  const resolution = (dependencies.resolveConfig ?? resolveOperatorConfig)()
  if (resolution.status === 'disabled') return respond(404, { error: 'NOT_FOUND' }, requestId)
  if (resolution.status === 'misconfigured') {
    return respond(503, { error: 'temporarily_unavailable' }, requestId)
  }
  const config = resolution.config
  const database = dependencies.database ?? db
  const started = Date.now()
  const now = (dependencies.now ?? (() => new Date()))()
  if (request.method !== 'POST') {
    return respond(405, { error: 'METHOD_NOT_ALLOWED' }, requestId, { allow: 'POST' })
  }
  const url = new URL(request.url)
  if (url.searchParams.has('access_token') || url.search.length > 0) {
    // Tokens are accepted only in the Authorization header (never logged URLs).
    return respond(400, { error: 'invalid_request' }, requestId)
  }
  if (!hasValidOrigin(request, config))
    return respond(403, { error: 'FORBIDDEN_ORIGIN' }, requestId)
  const authorization = request.headers.get('authorization')
  if (!authorization) return unauthorized(config, requestId, false)
  const match = /^Bearer ([A-Za-z0-9_-]{1,200})$/u.exec(authorization)
  if (!match) return unauthorized(config, requestId, true)
  const verification = await verifyOperatorAccessToken(match[1]!, config, now, database)
  if (!verification.ok) {
    // Only tokens we actually issued earn an audit row; guessed or foreign tokens are logged, so
    // unauthenticated traffic cannot grow the append-only trail.
    if (verification.reason !== 'MALFORMED' && verification.reason !== 'UNKNOWN') {
      await writeOperatorAuditBestEffort(
        { requestId, eventType: 'mcp.denied', outcome: `TOKEN_${verification.reason}` },
        database,
      )
    }
    return unauthorized(config, requestId, true)
  }
  const grant = verification.grant
  if (!acceptsMcpPost(request))
    return respond(406, { error: 'MCP_MEDIA_TYPES_REQUIRED' }, requestId)
  const protocolHeader = request.headers.get('mcp-protocol-version')
  if (protocolHeader !== null && !PROTOCOL_VERSIONS.has(protocolHeader.trim())) {
    return respond(400, { error: 'UNSUPPORTED_PROTOCOL_VERSION' }, requestId)
  }
  let payload: unknown
  try {
    payload = await boundedJson(request)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'BODY_TOO_LARGE'
    return respond(
      tooLarge ? 413 : 400,
      rpcError(null, -32700, tooLarge ? 'Request too large' : 'Parse error'),
      requestId,
    )
  }
  const parsed = RpcRequest.safeParse(payload)
  if (!parsed.success) return respond(400, rpcError(null, -32600, 'Invalid Request'), requestId)
  const rpc = parsed.data
  const id: RpcId = rpc.id ?? null
  const notification = rpc.id === undefined
  const registry = dependencies.registry ?? createOperatorRegistry()
  switch (rpc.method) {
    case 'initialize': {
      const requested = z
        .object({ protocolVersion: z.string().max(64) })
        .passthrough()
        .safeParse(rpc.params)
      const version =
        requested.success && PROTOCOL_VERSIONS.has(requested.data.protocolVersion)
          ? requested.data.protocolVersion
          : DEFAULT_PROTOCOL_VERSION
      return notification
        ? respond(202, null, requestId)
        : respond(
            200,
            {
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion: version,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'torchiko-operator', version: '1.0.0' },
                instructions:
                  'Call operator.get_manual first and follow it. Every write is a proposal; show Tom the approveUrl when a result is PENDING.',
              },
            },
            requestId,
          )
    }
    case 'notifications/initialized':
      return respond(202, null, requestId)
    case 'ping':
      return notification
        ? respond(202, null, requestId)
        : respond(200, { jsonrpc: '2.0', id, result: {} }, requestId)
    case 'tools/list':
      return notification
        ? respond(202, null, requestId)
        : respond(
            200,
            {
              jsonrpc: '2.0',
              id,
              result: {
                tools: registry.listTools().map((tool) => ({
                  name: tool.name,
                  title: tool.title,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  outputSchema: tool.outputSchema,
                  annotations: tool.annotations,
                })),
              },
            },
            requestId,
          )
    case 'tools/call':
      return respond(
        200,
        await callTool(rpc.params, id, grant, {
          config,
          database,
          registry,
          venueRead: dependencies.venueRead ?? defaultVenueRead(database),
          now,
          requestId,
          started,
        }),
        requestId,
      )
    default:
      return notification
        ? respond(202, null, requestId)
        : respond(200, rpcError(id, -32601, 'Method not found'), requestId)
  }
}

async function callTool(
  rawParams: unknown,
  id: RpcId,
  grant: VerifiedOperatorGrant,
  context: Readonly<{
    config: OperatorServerConfig
    database: OperatorDatabase
    registry: OperatorRegistry
    venueRead: VenueReadService
    now: Date
    requestId: string
    started: number
  }>,
) {
  const params = OperatorToolCallParams.safeParse(rawParams)
  if (!params.success) return rpcError(id, -32602, 'Invalid params')
  const { name, arguments: args } = params.data
  const base = {
    requestId: context.requestId,
    grantId: grant.grantId,
    clientId: grant.clientId,
    tool: name.slice(0, 120),
    argsHash: argsHash(args),
    args,
    ...targetOf(args),
  }
  const recent = await context.database.operatorAuditEvent.count({
    where: {
      grantId: grant.grantId,
      eventType: { in: ['mcp.call', 'mcp.denied'] },
      occurredAt: { gt: new Date(context.now.getTime() - 60_000) },
    },
  })
  if (recent >= CALLS_PER_MINUTE_PER_GRANT) {
    await writeOperatorAuditBestEffort(
      { ...base, eventType: 'mcp.denied', outcome: 'RATE_LIMITED' },
      context.database,
    )
    return { jsonrpc: '2.0' as const, id, result: toolResult({ error: 'RATE_LIMITED' }, true) }
  }
  try {
    const structured = await context.registry.callTool(name, args, {
      config: context.config,
      database: context.database,
      grant,
      now: context.now,
      requestId: context.requestId,
      venueRead: context.venueRead,
    })
    const view = structured as { proposalId?: unknown; status?: unknown }
    await writeOperatorAudit(
      {
        ...base,
        eventType: 'mcp.call',
        outcome: typeof view.status === 'string' ? `OK:${view.status}` : 'OK',
        proposalId: typeof view.proposalId === 'string' ? view.proposalId : null,
        latencyMs: Date.now() - context.started,
      },
      context.database,
    )
    return { jsonrpc: '2.0' as const, id, result: toolResult(structured) }
  } catch (error) {
    const code = errorCode(error)
    await writeOperatorAuditBestEffort(
      {
        ...base,
        eventType: code === 'TOOL_FAILED' ? 'mcp.call' : 'mcp.denied',
        outcome: code,
        latencyMs: Date.now() - context.started,
      },
      context.database,
    )
    return {
      jsonrpc: '2.0' as const,
      id,
      result: toolResult(
        code === 'INVALID_ARGUMENTS' && error instanceof z.ZodError
          ? {
              error: code,
              issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
            }
          : { error: code },
        true,
      ),
    }
  }
}
