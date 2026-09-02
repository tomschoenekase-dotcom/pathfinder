import { createHash, randomUUID } from 'node:crypto'

import { env } from '@pathfinder/config'
import { PlatformWorkerFounderDirectiveTaskRequest } from '@pathfinder/contracts/platform-worker-policy'
import {
  FounderDirectiveTaskError,
  materializeFounderDirectiveTaskAction,
  PlatformWorkerPolicyCredentialError,
  proposeFounderDirectiveTaskAction,
  readFounderDirectiveTasks,
  verifyPlatformWorkerPolicyCredentialCapability,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'
import { enqueueAgentRun } from '@pathfinder/jobs'

import { readBoundedJsonBody } from './bounded-json-body'

const MAX_BODY_BYTES = 64 * 1024
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

/**
 * Capability-separated founder directive handoff. Proposal creates only a human
 * approval request; materialization requires that exact approval and creates only
 * the canonical queued task. Downstream tools retain every consequential policy gate.
 */
export async function handlePlatformWorkerFounderDirectiveTasksRequest(
  request: Request,
  dependencies: {
    verify?: typeof verifyPlatformWorkerPolicyCredentialCapability
    read?: typeof readFounderDirectiveTasks
    propose?: typeof proposeFounderDirectiveTaskAction
    materialize?: typeof materializeFounderDirectiveTaskAction
    enqueue?: typeof enqueueAgentRun
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
    parsed = PlatformWorkerFounderDirectiveTaskRequest.parse(
      await readBoundedJsonBody(request, MAX_BODY_BYTES),
    )
  } catch {
    return response(400, { error: 'INVALID_REQUEST' }, requestId)
  }
  const capability =
    parsed.action === 'read'
      ? ('founder-directive-tasks:read' as const)
      : parsed.action === 'propose'
        ? ('founder-directive-tasks:propose' as const)
        : ('founder-directive-tasks:materialize' as const)
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
      const result = await withTenantIsolationBypass(() =>
        (dependencies.read ?? readFounderDirectiveTasks)({
          limit: parsed.limit,
          ...(parsed.status ? { status: parsed.status } : {}),
        }),
      )
      await (dependencies.audit ?? writeAuditLogStrict)({
        actorId: credential.workerId,
        actorRole: 'PLATFORM_POLICY_WORKER',
        actorType: 'AGENT',
        credentialId: credential.credentialId,
        capability,
        action: 'platform-worker-policy.founder-directive-tasks-read',
        targetType: 'FounderDirectiveTaskRequest',
        targetId: requestId,
        structuredReason: {
          effect: 'READ_ONLY',
          limit: parsed.limit,
          status: parsed.status ?? null,
        },
        afterState: { returned: result.items.length },
      })
      return response(200, result, requestId)
    }

    if (parsed.action === 'propose') {
      const { action: _, ...payload } = parsed
      void _
      const result = await withTenantIsolationBypass(() =>
        (dependencies.propose ?? proposeFounderDirectiveTaskAction)({
          ...payload,
          actor: {
            type: 'AGENT',
            id: credential.workerId,
            credentialId: credential.credentialId,
            capability,
          },
        }),
      )
      return response(result.replayed ? 200 : 201, result, requestId)
    }

    const { action: _, ...payload } = parsed
    void _
    const result = await withTenantIsolationBypass(() =>
      (dependencies.materialize ?? materializeFounderDirectiveTaskAction)({
        ...payload,
        actor: {
          type: 'AGENT',
          id: credential.workerId,
          credentialId: credential.credentialId,
          capability,
        },
      }),
    )
    const dispatch =
      result.run.status === 'QUEUED'
        ? await (dependencies.enqueue ?? enqueueAgentRun)(
            { tenantId: result.request.tenantId, runId: result.run.id },
            { enabled: env.AGENT_RUNNER_ENABLED },
          )
        : { enqueued: false }
    return response(
      result.replayed ? 200 : 201,
      { ...result, executionTriggered: dispatch.enqueued },
      requestId,
    )
  } catch (error) {
    if (error instanceof FounderDirectiveTaskError) {
      const status =
        error.code === 'INVALID_INPUT'
          ? 400
          : error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'INACTIVE_CREDENTIAL'
              ? 401
              : error.code === 'FORBIDDEN'
                ? 403
                : 409
      return response(status, { error: error.code }, requestId)
    }
    return response(503, { error: 'FOUNDER_DIRECTIVE_TASKS_UNAVAILABLE' }, requestId)
  }
}
