import { createHash, randomUUID } from 'node:crypto'

import { PlatformWorkerOperationsReadinessRequest } from '@pathfinder/contracts/platform-worker-policy'
import {
  PlatformWorkerPolicyCredentialError,
  verifyPlatformWorkerPolicyCredentialCapability,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { readOperationsReadiness } from '../operations-readiness'
import { readBoundedJsonBody } from './bounded-json-body'

const MAX_BODY_BYTES = 1024
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

function response(status: number, value: unknown, requestId: string) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  })
}

/** Platform-wide, read-only health evidence for an explicitly activated machine credential. */
export async function handlePlatformWorkerOperationsReadinessRequest(
  request: Request,
  dependencies: {
    verify?: typeof verifyPlatformWorkerPolicyCredentialCapability
    resolve?: typeof readOperationsReadiness
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
    credential = await (dependencies.verify ?? verifyPlatformWorkerPolicyCredentialCapability)(
      match[1]!,
      'operations-readiness:read',
    )
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
  try {
    PlatformWorkerOperationsReadinessRequest.parse(
      await readBoundedJsonBody(request, MAX_BODY_BYTES, { emptyValue: {} }),
    )
  } catch {
    return response(400, { error: 'INVALID_REQUEST' }, requestId)
  }
  try {
    const result = await withTenantIsolationBypass(() =>
      (dependencies.resolve ?? readOperationsReadiness)(),
    )
    await (dependencies.audit ?? writeAuditLogStrict)({
      actorId: credential.workerId,
      actorRole: 'PLATFORM_POLICY_WORKER',
      actorType: 'AGENT',
      credentialId: credential.credentialId,
      capability: 'operations-readiness:read',
      action: 'platform-worker-policy.operations-readiness-read',
      targetType: 'OperationsReadiness',
      targetId: requestId,
      structuredReason: { effect: 'READ_ONLY', scope: 'PLATFORM' },
      afterState: {
        status: result.status,
        liveQueueStatus: result.queue.live.status,
        liveQueueCoverage:
          result.queue.live.status === 'observed' ? result.queue.live.coverage.complete : false,
      },
    })
    return response(200, result, requestId)
  } catch {
    return response(503, { error: 'OPERATIONS_READINESS_UNAVAILABLE' }, requestId)
  }
}
