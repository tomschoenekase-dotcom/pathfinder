import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { ExternalCredentialVerificationError, verifyAgentBridgeCredential } from '@pathfinder/db'

import { createAgentBridgeRegistry } from './registry'

const MAX_BODY_BYTES = 128 * 1024
const methodSchema = z.enum([
  'register',
  'heartbeatSession',
  'claimTask',
  'heartbeatTask',
  'completeTask',
  'failTask',
  'callProspectTool',
])
const envelopeSchema = z.object({ method: methodSchema, params: z.unknown() }).strict()
const routeScopeSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
  })
  .strict()

type Registry = ReturnType<typeof createAgentBridgeRegistry>

const attemptWindows = new Map<string, { startedAt: number; count: number }>()

function allowBridgeAttempt(key: string, now = Date.now()) {
  const window = attemptWindows.get(key)
  if (!window || now - window.startedAt >= 60_000) {
    if (attemptWindows.size >= 10_000) {
      for (const [candidate, state] of attemptWindows) {
        if (now - state.startedAt >= 60_000) attemptWindows.delete(candidate)
      }
      if (attemptWindows.size >= 10_000) return false
    }
    attemptWindows.set(key, { startedAt: now, count: 1 })
    return true
  }
  window.count += 1
  return window.count <= 30
}

function json(status: number, payload: unknown, requestId?: string) {
  return new Response(
    JSON.stringify(payload, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
    },
  )
}

async function boundedJson(request: Request) {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new Error('BODY_TOO_LARGE')
  if (!request.body) throw new Error('INVALID_JSON')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let reading = true
  while (reading) {
    const { done, value } = await reader.read()
    if (done) {
      reading = false
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
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error('INVALID_JSON')
  }
}

/** Bounded HTTP composition for a user-controlled bridge runner. Authentication
 * occurs before request-body parsing and all errors are non-secret shaped. */
export async function handleAgentBridgeHttpRequest(
  request: Request,
  rawScope: unknown,
  dependencies: {
    verify?: typeof verifyAgentBridgeCredential
    registry?: Registry
    allowAttempt?: (key: string) => boolean
  } = {},
): Promise<Response> {
  const requestId = randomUUID()
  if (request.method !== 'POST')
    return json(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED' } }, requestId)
  const scope = routeScopeSchema.safeParse(rawScope)
  if (!scope.success) return json(404, { ok: false, error: { code: 'NOT_FOUND' } }, requestId)
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^Bearer (pf_mcp_[A-Za-z0-9_-]{43})$/u)
  if (!match) return json(401, { ok: false, error: { code: 'UNAUTHORIZED' } }, requestId)
  const attemptKey = createHash('sha256')
    .update(`${scope.data.tenantId}\u0000${scope.data.venueId}\u0000${match[1]}`)
    .digest('hex')
  const allowAttempt = dependencies.allowAttempt ?? allowBridgeAttempt
  if (!allowAttempt(attemptKey))
    return json(429, { ok: false, error: { code: 'RATE_LIMITED' } }, requestId)
  let credential
  try {
    const verify = dependencies.verify ?? verifyAgentBridgeCredential
    credential = await verify({
      ...scope.data,
      plaintext: match[1]!,
    })
  } catch (error) {
    if (error instanceof ExternalCredentialVerificationError)
      return json(401, { ok: false, error: { code: 'UNAUTHORIZED' } }, requestId)
    return json(503, { ok: false, error: { code: 'AUTH_UNAVAILABLE' } }, requestId)
  }
  let envelope: z.infer<typeof envelopeSchema>
  try {
    envelope = envelopeSchema.parse(await boundedJson(request))
  } catch (error) {
    return json(
      400,
      {
        ok: false,
        error: { code: error instanceof Error ? error.message : 'INVALID_REQUEST' },
      },
      requestId,
    )
  }
  const registry = dependencies.registry ?? createAgentBridgeRegistry()
  const context = { credential }
  try {
    let result: unknown
    switch (envelope.method) {
      case 'register':
        result = await registry.register(envelope.params, context)
        break
      case 'heartbeatSession':
        result = await registry.heartbeatSession(envelope.params, context)
        break
      case 'claimTask':
        result = await registry.claimTask(envelope.params, context)
        break
      case 'heartbeatTask':
        result = await registry.heartbeatTask(envelope.params, context)
        break
      case 'completeTask':
        result = await registry.completeTask(envelope.params, context)
        break
      case 'failTask':
        result = await registry.failTask(envelope.params, context)
        break
      case 'callProspectTool':
        result = await registry.callProspectTool(envelope.params, context)
        break
    }
    return json(200, { ok: true, result }, requestId)
  } catch {
    return json(409, { ok: false, error: { code: 'BRIDGE_OPERATION_REJECTED' } }, requestId)
  }
}
