import { createHash, randomUUID } from 'node:crypto'

import { PlatformWorkerFounderDecisionRequest } from '@pathfinder/contracts/platform-worker-policy'
import {
  getFounderDecisionCurrentTruth,
  PlatformWorkerPolicyCredentialError,
  verifyPlatformWorkerPolicyCredential,
  writeAuditLogStrict,
} from '@pathfinder/db'

const MAX_BODY_BYTES = 32 * 1024
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

async function body(request: Request) {
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

/** Read-only platform policy endpoint. It is not part of customer MCP and executes no action. */
export async function handlePlatformWorkerFounderDecisionRequest(
  request: Request,
  dependencies: {
    verify?: typeof verifyPlatformWorkerPolicyCredential
    resolve?: typeof getFounderDecisionCurrentTruth
    audit?: typeof writeAuditLogStrict
    allowAttempt?: (key: string) => boolean
  } = {},
): Promise<Response> {
  const requestId = randomUUID()
  if (request.method !== 'POST') return response(405, { error: 'METHOD_NOT_ALLOWED' }, requestId)
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^Bearer (pf_platform_[A-Za-z0-9_-]{43})$/u)
  if (!match) return response(401, { error: 'UNAUTHORIZED' }, requestId)
  const attemptKey = createHash('sha256').update(match[1]!).digest('hex')
  if (!(dependencies.allowAttempt ?? allowAttempt)(attemptKey)) {
    return response(429, { error: 'RATE_LIMITED' }, requestId)
  }
  let credential
  try {
    credential = await (dependencies.verify ?? verifyPlatformWorkerPolicyCredential)(match[1]!)
  } catch (error) {
    return response(
      error instanceof PlatformWorkerPolicyCredentialError ? 401 : 503,
      {
        error:
          error instanceof PlatformWorkerPolicyCredentialError
            ? 'UNAUTHORIZED'
            : 'AUTH_UNAVAILABLE',
      },
      requestId,
    )
  }
  let parsed
  try {
    parsed = PlatformWorkerFounderDecisionRequest.parse(await body(request))
  } catch {
    return response(400, { error: 'INVALID_REQUEST' }, requestId)
  }
  try {
    const result = await (dependencies.resolve ?? getFounderDecisionCurrentTruth)(parsed)
    await (dependencies.audit ?? writeAuditLogStrict)({
      actorId: credential.workerId,
      actorRole: 'PLATFORM_POLICY_WORKER',
      actorType: 'AGENT',
      credentialId: credential.credentialId,
      capability: 'founder-decisions:read',
      action: 'platform-worker-policy.founder-decisions-read',
      targetType: 'FounderDecisionKeySet',
      targetId: requestId,
      structuredReason: { keys: parsed.keys, complete: result.complete },
      afterState: { returned: result.decisions.length, missing: result.missingKeys.length },
    })
    return response(200, result, requestId)
  } catch {
    return response(409, { error: 'POLICY_RECONCILIATION_REQUIRED' }, requestId)
  }
}
