import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { getOperatorToolDefinition } from '@pathfinder/contracts/operator-mcp'
import { db } from '@pathfinder/db'

import { admitCall } from './admission'
import { writeOperatorAudit, writeOperatorAuditBestEffort, type OperatorDatabase } from './audit'
import {
  protectedResourceMetadataUrl,
  resolveOperatorConfig,
  type OperatorConfigResolution,
  type OperatorServerConfig,
} from './config'
import {
  OperatorCapabilityError,
  OperatorNotFoundError,
  OperatorScopeTooLargeError,
} from './grants'
import { verifyOperatorAccessToken, type VerifiedOperatorGrant } from './oauth'
import { OPERATOR_KIND_REFUSAL_CODES, OperatorProposalError } from './proposals'
import {
  createOperatorRegistry,
  defaultVenueRead,
  OperatorToolCallParams,
  OperatorOutputInvalidError,
  OperatorUnknownToolError,
  type OperatorRegistry,
  type VenueReadService,
} from './registry'
import { argsHash } from './tokens'
import { OperatorInvalidCursorError } from './tools/page'

const MAX_BODY_BYTES = 128 * 1024
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

/** Refusals a kind raises at propose time that the Dot should see by name. */
const KIND_REFUSAL_CODES = OPERATOR_KIND_REFUSAL_CODES

/** Structured, non-sensitive detail a kind attaches to its refusal (current state, matches). */
function refusalDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object' || !('details' in error)) return {}
  const details = (error as { details: unknown }).details
  if (!details || typeof details !== 'object') return {}
  const code = errorCode(error)
  return KIND_REFUSAL_CODES.has(code) ? { details } : {}
}

export function errorCode(error: unknown): string {
  if (error instanceof OperatorNotFoundError) return 'NOT_FOUND'
  if (error instanceof OperatorCapabilityError) return 'CAPABILITY_DENIED'
  if (error instanceof OperatorUnknownToolError) return 'UNKNOWN_TOOL'
  if (error instanceof OperatorProposalError) return error.code
  if (error instanceof z.ZodError) return 'INVALID_ARGUMENTS'
  if (error instanceof OperatorInvalidCursorError) return 'INVALID_CURSOR'
  if (error instanceof OperatorScopeTooLargeError) return 'SCOPE_TOO_LARGE'
  if (error instanceof OperatorOutputInvalidError) return 'OUTPUT_INVALID'
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  if (OPERATOR_KIND_REFUSAL_CODES.has(code)) return code
  if (['INVALID_CSV', 'FETCH_FAILED', 'SCOPE_REQUIRED', 'OPERATION_CONFLICT'].includes(code))
    return code
  return 'TOOL_FAILED'
}

type ErrorGuidance = Readonly<{
  retryable: boolean
  retryAfterSeconds?: number
  nextAction: string
}>

const ERROR_GUIDANCE: Readonly<Record<string, ErrorGuidance>> = {
  INVALID_CSV: {
    retryable: false,
    nextAction: 'Correct the CSV format, mapping or size. No import rows were staged by this call.',
  },
  FETCH_FAILED: {
    retryable: true,
    nextAction:
      'Supply a fresh authorized CSV attachment link or csvText and retry with the same operationId.',
  },
  SCOPE_REQUIRED: {
    retryable: false,
    nextAction: 'CSV imports require an owner-authorized platform-wide CRM connection.',
  },
  OPERATION_CONFLICT: {
    retryable: false,
    nextAction:
      'This operationId belongs to a different file or mapping. Recover the original import before starting distinct work.',
  },
  NOT_FOUND: {
    retryable: false,
    nextAction:
      'Find the id with a discovery read (customers.list, venues.list, crm.search_organizations, crm.list_campaigns). A target outside this connection looks the same as a missing one.',
  },
  CAPABILITY_DENIED: {
    retryable: false,
    nextAction:
      'Read operator.get_context. This connection lacks the capability; the owner must reconnect it.',
  },
  UNKNOWN_TOOL: {
    retryable: false,
    nextAction: 'Read operator.get_context for the available tools.',
  },
  INVALID_ARGUMENTS: {
    retryable: false,
    nextAction: 'Correct the arguments at the listed paths and call again.',
  },
  INVALID_CURSOR: { retryable: false, nextAction: 'Start the list again without a cursor.' },
  SCOPE_TOO_LARGE: {
    retryable: false,
    nextAction:
      'This tenant has more venues than one read scope supports. Ask the owner; do not assume a subset is complete.',
  },
  OUTPUT_INVALID: {
    retryable: false,
    nextAction:
      'The server built an invalid response. Report it; nothing in the data was changed by a read.',
  },
  NOT_CANCELLABLE: {
    retryable: false,
    nextAction:
      'Read operator.get_operation. Work that already started cannot be cancelled; recover it or wait for it to finish.',
  },
  RATE_LIMITED: {
    retryable: true,
    retryAfterSeconds: 60,
    nextAction: 'Wait, then repeat the same call.',
  },
  NOT_RECORDED: {
    retryable: true,
    nextAction:
      'Nothing was recorded and nothing was changed, so there is no operation to look up. It is safe to send the same request again with the same operationId.',
  },
  DISABLED: {
    retryable: false,
    nextAction:
      'This action is switched off on this deployment. Nothing was recorded or changed. Ask the owner to enable it.',
  },
  SLUG_TAKEN: {
    retryable: false,
    nextAction: 'Nothing was changed. Choose a different slug and propose again.',
  },
  UNRECONCILED_PRIOR_OPERATION: {
    retryable: false,
    nextAction:
      'An earlier operation for this same customer has an unconfirmed outcome. Call operator.recover_operation with that earlier operationId until it settles. Do not send a new operationId; that could create a second customer.',
  },
  STALE: {
    retryable: false,
    nextAction: 'Read the target again and propose again with the new version.',
  },
  TARGET_CHANGED: {
    retryable: false,
    nextAction: 'Read the target again and propose again with the new version.',
  },
  DUPLICATE_REVIEW: {
    retryable: false,
    nextAction:
      'A matching account already exists (see details.matches). Do not create another: use the existing account, or ask a person to review the duplicate. Never retry with a new operationId.',
  },
  IMPORT_NOT_READY: {
    retryable: false,
    nextAction:
      'Read crm.get_import. The import must finish staging, have no unresolved duplicate rows, and match the hashes you read. Stage CSV attachments with crm.stage_csv_import; review uncertain duplicate rows in the admin app.',
  },
  OWNER_NOT_FOUND: {
    retryable: false,
    nextAction:
      'No user in the directory has that id or address. Ask which person is meant; never guess an owner.',
  },
  CHANGESET_INVALID: {
    retryable: false,
    nextAction:
      'Read the rows with venues.list_content and venues.get_content, run venues.preview_content_changeset to see each problem, then propose a corrected changeset.',
  },
  SOURCE_HOST_NOT_AUTHORIZED: {
    retryable: false,
    nextAction:
      'Only hosts the venue has authorized as website origins can be captured. Ask a person to add the origin, then propose again. Nothing was fetched.',
  },
  SOURCE_LIMIT: {
    retryable: true,
    retryAfterSeconds: 120,
    nextAction: 'Read venues.list_sources and wait for a capture to finish, then propose again.',
  },
  SOURCE_ALREADY_PENDING: {
    retryable: false,
    nextAction: 'Read venues.list_sources; this URL is already queued. Do not request it again.',
  },
}

/** The structured error a caller sees: stable code, retryability, request id and a safe next step. */
export function errorBody(
  code: string,
  name: string,
  requestId: string,
  extra: Record<string, unknown> = {},
) {
  const effect = getOperatorToolDefinition(name)?.effect
  const write = effect !== undefined && effect !== 'read'
  const known =
    name === 'crm.stage_csv_import' && code === 'TOOL_FAILED'
      ? {
          retryable: false,
          nextAction:
            'The staging outcome is unknown. Repeat crm.stage_csv_import with the same operationId and original file or csvText to recover its durable import receipt. Do not create a new operationId for the same import.',
        }
      : ERROR_GUIDANCE[code]
  // A failed write call may still have recorded the proposal, so the same operationId is the
  // only safe way to find out. A new operationId could repeat the effect.
  const unknownWrite = write && code === 'TOOL_FAILED'
  const guidance: ErrorGuidance =
    known ??
    (unknownWrite
      ? {
          retryable: false,
          nextAction:
            'The outcome is unknown. Call operator.get_operation with the same operationId before doing anything else. Never send a new operationId for the same change.',
        }
      : {
          retryable: !write && code === 'TOOL_FAILED',
          nextAction: write
            ? 'Read the target and operator.get_operation before deciding what to do.'
            : 'Repeat the read once; if it fails again, report the requestId.',
        })
  return {
    error: code,
    retryable: guidance.retryable,
    ...(guidance.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: guidance.retryAfterSeconds }),
    requestId,
    nextAction: guidance.nextAction,
    // A write refused before any record existed provably changed nothing.
    ...(unknownWrite
      ? { outcome: 'unknown' }
      : write && code !== 'TOOL_FAILED'
        ? { outcome: 'none' }
        : {}),
    ...(code === 'NOT_RECORDED' ? { operationRecorded: false } : {}),
    ...extra,
  }
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
                serverInfo: { name: 'torchiko-operator', version: '1.2.0' },
                instructions:
                  'Call operator.get_context and operator.get_manual first. Routine authorized CRM writes can apply immediately. Read each result; show the approveUrl only when a proposal remains PENDING. CSV attachments use crm.stage_csv_import before crm.propose_import_commit.',
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
                  ...(tool._meta ? { _meta: tool._meta } : {}),
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
  // Counted by the statement that admits the call, so a burst cannot all pass a read-then-act gap.
  const admission = await admitCall(context.database, grant.grantId, context.now)
  if (!admission.allowed) {
    // One denial row per window; further retries only raise the counter.
    if (admission.firstDenial) {
      await writeOperatorAuditBestEffort(
        { ...base, eventType: 'mcp.denied', outcome: 'RATE_LIMITED' },
        context.database,
      )
    }
    return {
      jsonrpc: '2.0' as const,
      id,
      result: toolResult(
        errorBody('RATE_LIMITED', name, context.requestId, {
          retryAfterSeconds: admission.retryAfterSeconds,
        }),
        true,
      ),
    }
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
          ? errorBody(code, name, context.requestId, {
              issues: error.issues.map((issue) => ({
                path: issue.path,
                code: issue.code,
                // Only our own refinement text is echoed; built-in messages can quote input.
                ...(issue.code === 'custom' ? { message: issue.message } : {}),
              })),
            })
          : errorBody(
              code,
              name,
              context.requestId,
              name === 'operator.get_operation' && code === 'NOT_FOUND'
                ? {
                    operationRecorded: false,
                    nextAction:
                      'No operation with this operationId is recorded for this connection. A write that returned an error with outcome "none" or "operationRecorded: false" changed nothing and may be sent again with the same operationId. If the original call returned a different error, read the target before sending anything.',
                  }
                : refusalDetails(error),
            ),
        true,
      ),
    }
  }
}
