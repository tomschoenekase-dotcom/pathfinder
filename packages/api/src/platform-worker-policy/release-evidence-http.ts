import { createHash, randomUUID } from 'node:crypto'

import { PlatformWorkerReleaseEvidenceRequest } from '@pathfinder/contracts/release-evidence'
import {
  PlatformReleaseEvidenceError,
  PlatformWorkerPolicyCredentialError,
  readPlatformReleaseEvidence,
  recordPlatformReleaseEvidenceAction,
  verifyPlatformWorkerPolicyCredentialCapability,
  writeAuditLogStrict,
} from '@pathfinder/db'

const MAX_BODY_BYTES = 128 * 1024
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

async function body(request: Request) {
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new Error('BODY_TOO_LARGE')
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE')
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

/** Bounded platform release evidence. Recording evidence never deploys or grants release authority. */
export async function handlePlatformWorkerReleaseEvidenceRequest(
  request: Request,
  dependencies: {
    verify?: typeof verifyPlatformWorkerPolicyCredentialCapability
    read?: typeof readPlatformReleaseEvidence
    record?: typeof recordPlatformReleaseEvidenceAction
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

  let parsed
  try {
    parsed = PlatformWorkerReleaseEvidenceRequest.parse(await body(request))
  } catch {
    return response(400, { error: 'INVALID_REQUEST' }, requestId)
  }
  const capability =
    parsed.action === 'read'
      ? ('release-evidence:read' as const)
      : ('release-evidence:record' as const)
  let credential
  try {
    credential = await (dependencies.verify ?? verifyPlatformWorkerPolicyCredentialCapability)(
      match[1]!,
      capability,
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
    if (parsed.action === 'read') {
      const result = await (dependencies.read ?? readPlatformReleaseEvidence)(parsed.limit)
      await (dependencies.audit ?? writeAuditLogStrict)({
        actorId: credential.workerId,
        actorRole: 'PLATFORM_POLICY_WORKER',
        actorType: 'AGENT',
        credentialId: credential.credentialId,
        capability,
        action: 'platform-worker-policy.release-evidence-read',
        targetType: 'PlatformReleaseEvidence',
        targetId: requestId,
        structuredReason: { effect: 'READ_ONLY', scope: 'PLATFORM', limit: parsed.limit },
        afterState: {
          returned: result.items.length,
          currentRevision: result.current?.revision ?? null,
        },
      })
      return response(200, result, requestId)
    }

    const { action: _, ...payload } = parsed
    void _
    const result = await (dependencies.record ?? recordPlatformReleaseEvidenceAction)({
      ...payload,
      actor: {
        type: 'AGENT',
        id: credential.workerId,
        credentialId: credential.credentialId,
        capability,
      },
    })
    return response(result.replayed ? 200 : 201, result, requestId)
  } catch (error) {
    if (error instanceof PlatformReleaseEvidenceError) {
      const status =
        error.code === 'INVALID_INPUT' ? 400 : error.code === 'INACTIVE_CREDENTIAL' ? 401 : 409
      return response(status, { error: error.code }, requestId)
    }
    return response(503, { error: 'RELEASE_EVIDENCE_UNAVAILABLE' }, requestId)
  }
}
