import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { ExternalCredentialVerificationError, verifyAgentBridgeCredential } from '@pathfinder/db'

import { createSafeOperationalMcpRegistry } from './composition'
import { dispatchMcpJsonRpc } from './json-rpc'

const MAX_BODY_BYTES = 128 * 1024
const HANDSHAKE_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
])
const routeScope = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191).optional(),
  })
  .strict()
const attempts = new Map<string, { at: number; count: number }>()

function allowAttempt(key: string, now = Date.now()) {
  const state = attempts.get(key)
  if (!state || now - state.at >= 60_000) {
    attempts.set(key, { at: now, count: 1 })
    return true
  }
  state.count += 1
  return state.count <= 30
}

async function boundedBody(request: Request) {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new Error('BODY_TOO_LARGE')
  }
  if (!request.body) throw new Error('INVALID_JSON')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let complete = false
  while (!complete) {
    const { done, value } = await reader.read()
    if (done) {
      complete = true
      continue
    }
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

function response(status: number, body: unknown, requestId: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  })
}

function acceptsMcpPost(request: Request) {
  const mediaTypes = (request.headers.get('accept') ?? '')
    .split(',')
    .map((entry) => {
      const [mediaType, ...parameters] = entry.split(';').map((part) => part.trim().toLowerCase())
      const quality = parameters.find((parameter) => parameter.startsWith('q='))?.slice(2)
      return quality !== undefined && Number(quality) <= 0 ? null : mediaType
    })
    .filter((mediaType): mediaType is string => Boolean(mediaType))
  return (
    mediaTypes.includes('application/json') &&
    mediaTypes.includes('text/event-stream') &&
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
      'application/json'
  )
}

function hasValidOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function initializeVersion(payload: unknown) {
  if (typeof payload !== 'object' || payload === null || !('method' in payload)) return null
  if ((payload as { method?: unknown }).method !== 'initialize') return null
  const params = z
    .object({ protocolVersion: z.string().trim().min(1).max(64) })
    .passthrough()
    .safeParse((payload as { params?: unknown }).params)
  return params.success && HANDSHAKE_PROTOCOL_VERSIONS.has(params.data.protocolVersion)
    ? params.data.protocolVersion
    : null
}

function negotiateInitializeResult(result: unknown, protocolVersion: string | null) {
  if (!protocolVersion || typeof result !== 'object' || result === null || !('result' in result))
    return result
  const envelope = result as { result?: unknown }
  if (typeof envelope.result !== 'object' || envelope.result === null) return result
  return {
    ...envelope,
    result: { ...envelope.result, protocolVersion },
  }
}

/** Stateless MCP Streamable-HTTP-compatible POST endpoint over Packet A credentials. */
export async function handleMcpHttpRequest(
  request: Request,
  rawScope: unknown,
  dependencies: {
    verify?: typeof verifyAgentBridgeCredential
    registry?: ReturnType<typeof createSafeOperationalMcpRegistry>
    allowAttempt?: (key: string) => boolean
  } = {},
): Promise<Response> {
  const requestId = randomUUID()
  if (request.method !== 'POST') {
    return response(405, { error: 'METHOD_NOT_ALLOWED' }, requestId)
  }
  if (!hasValidOrigin(request)) {
    return response(403, { error: 'FORBIDDEN_ORIGIN' }, requestId)
  }
  if (!acceptsMcpPost(request)) {
    return response(406, { error: 'MCP_MEDIA_TYPES_REQUIRED' }, requestId)
  }
  const scope = routeScope.safeParse(rawScope)
  if (!scope.success) return response(404, { error: 'NOT_FOUND' }, requestId)
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^Bearer (pf_mcp_[A-Za-z0-9_-]{43})$/u)
  if (!match) return response(401, { error: 'UNAUTHORIZED' }, requestId)
  const attemptKey = createHash('sha256')
    .update(`${scope.data.tenantId}\u0000${scope.data.venueId ?? ''}\u0000${match[1]}`)
    .digest('hex')
  if (!(dependencies.allowAttempt ?? allowAttempt)(attemptKey)) {
    return response(429, { error: 'RATE_LIMITED' }, requestId)
  }
  let credential
  try {
    credential = await (dependencies.verify ?? verifyAgentBridgeCredential)({
      tenantId: scope.data.tenantId,
      ...(scope.data.venueId !== undefined ? { venueId: scope.data.venueId } : {}),
      plaintext: match[1]!,
    })
  } catch (caught) {
    return response(
      caught instanceof ExternalCredentialVerificationError ? 401 : 503,
      {
        error:
          caught instanceof ExternalCredentialVerificationError
            ? 'UNAUTHORIZED'
            : 'AUTH_UNAVAILABLE',
      },
      requestId,
    )
  }
  let payload: unknown
  try {
    payload = await boundedBody(request)
  } catch {
    return response(
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      requestId,
    )
  }
  const requestedInitializeVersion = initializeVersion(payload)
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'method' in payload &&
    (payload as { method?: unknown }).method === 'initialize' &&
    requestedInitializeVersion === null
  ) {
    return response(400, { error: 'UNSUPPORTED_PROTOCOL_VERSION' }, requestId)
  }
  const protocolVersionHeader = request.headers.get('mcp-protocol-version')
  if (
    protocolVersionHeader !== null &&
    !HANDSHAKE_PROTOCOL_VERSIONS.has(protocolVersionHeader.trim())
  ) {
    return response(400, { error: 'UNSUPPORTED_PROTOCOL_VERSION' }, requestId)
  }
  const registry = dependencies.registry ?? createSafeOperationalMcpRegistry()
  const result = await dispatchMcpJsonRpc(payload, { credential }, registry)
  const compatibleResult = negotiateInitializeResult(result, requestedInitializeVersion)
  return compatibleResult === null
    ? new Response(null, {
        status: 202,
        headers: { 'cache-control': 'no-store', 'x-request-id': requestId },
      })
    : response(200, compatibleResult, requestId)
}
