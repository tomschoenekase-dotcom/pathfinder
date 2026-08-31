import { randomUUID } from 'node:crypto'

import { AiGatewayError, AiRequestBudgetCeilingExceededError, AiRoutingError } from '@pathfinder/ai'
import { env, logger } from '@pathfinder/config'
import {
  assertVenueAiAvailable,
  claimGuestAnswerAttributionEvaluationRequestAction,
  completeGuestAnswerAttributionEvaluationRequestAction,
  db,
  failGuestAnswerAttributionEvaluationRequestAction,
  type GuestAnswerAttributionEvaluationFailureCode,
  isEvaluationRuntimeDurablyEnabled,
  markGuestAnswerAttributionEvaluationDispatchedAction,
  recoverStaleGuestAnswerAttributionEvaluationRequestsAction,
  resolveRuntimeAiWorkloadConfiguration,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import {
  enqueueGuestAnswerAttributionEvaluation,
  type GuestAnswerAttributionEvaluationJobPayload,
} from '@pathfinder/jobs'
import { runProviderBackedGuestAnswerAttributionEvaluation } from '@pathfinder/api/guest-answer-attribution-evaluation'

import { createWorkerAiBudgetGate, createWorkerAiUsageSink } from '../lib/ai-usage'

export const GUEST_ANSWER_ATTRIBUTION_EVALUATION_FLAG = 'evaluation-runner-v1'

async function tenantEnabled(tenantId: string): Promise<boolean> {
  return withTenantIsolationBypass(() =>
    db.tenantFeatureFlag.findUnique({
      where: {
        tenantId_flagKey: {
          tenantId,
          flagKey: GUEST_ANSWER_ATTRIBUTION_EVALUATION_FLAG,
        },
      },
      select: { enabled: true },
    }),
  ).then((flag) => flag?.enabled === true)
}

async function assertExecutionAllowed(input: {
  tenantId: string
  venueId: string
  requestId: string
  leaseToken: string
}) {
  if (!env.EVALUATION_RUNNER_ENABLED) throw new Error('Evaluation runtime is disabled')
  const [durableEnabled, enabled] = await Promise.all([
    isEvaluationRuntimeDurablyEnabled(db),
    tenantEnabled(input.tenantId),
  ])
  if (!durableEnabled || !enabled) throw new Error('Evaluation policy gate is disabled')
  await assertVenueAiAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
  const owned = await withTenantIsolationBypass(() =>
    db.guestAnswerAttributionEvaluationRequest.findFirst({
      where: {
        id: input.requestId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'RUNNING',
        leaseToken: input.leaseToken,
        leaseExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
  )
  if (!owned) throw new Error('Guest answer evaluation lease is unavailable')
}

function boundedErrorCode(error: unknown): GuestAnswerAttributionEvaluationFailureCode {
  if (error instanceof AiRequestBudgetCeilingExceededError) return error.code
  if (error instanceof AiRoutingError) return error.code
  if (error instanceof AiGatewayError) {
    if (
      error.code === 'provider-not-configured' ||
      error.code === 'provider-client-initialization'
    ) {
      return 'PROVIDER_CONFIGURATION_REQUIRED'
    }
    if (
      error.code === 'provider-connection-timeout' ||
      error.code === 'provider-connection-error'
    ) {
      return 'PROVIDER_CONNECTION_FAILED'
    }
    if (error.code === 'provider-user-abort') return 'PROVIDER_REQUEST_ABORTED'
    if (
      error.code === 'missing-text-block' ||
      error.code === 'invalid-structured-output' ||
      error.code === 'invalid-provider-response' ||
      error.code === 'provider-incomplete-response'
    ) {
      return 'PROVIDER_INVALID_RESPONSE'
    }
    return 'PROVIDER_REQUEST_FAILED'
  }
  return 'GUEST_ANSWER_ATTRIBUTION_EVALUATION_FAILED'
}

/** Performs one exact semantic review. Policy is rechecked both before claim and at provider
 * admission; the request dispatch timestamp is the single durable provider-I/O fence. */
export async function processGuestAnswerAttributionEvaluationJob(
  payload: GuestAnswerAttributionEvaluationJobPayload,
  signal?: AbortSignal,
) {
  if (!env.EVALUATION_RUNNER_ENABLED) return { state: 'disabled' as const }
  if (!(await isEvaluationRuntimeDurablyEnabled(db)) || !(await tenantEnabled(payload.tenantId))) {
    return { state: 'disabled' as const }
  }
  const leaseToken = randomUUID()
  const claim = await withTenantIsolationBypass(() =>
    claimGuestAnswerAttributionEvaluationRequestAction({ ...payload, leaseToken }),
  )
  if (claim.state !== 'claimed') return { state: 'not-claimed' as const }

  try {
    if (
      claim.request.answerHash !== payload.answerHash ||
      claim.request.evidenceSetHash !== payload.evidenceSetHash
    ) {
      throw new Error('Queued guest answer evaluation identity does not match durable state')
    }
    const configuration = await resolveRuntimeAiWorkloadConfiguration(
      {
        workloadId: 'guest-answer-attribution-evaluation',
        tenantId: payload.tenantId,
        venueId: payload.venueId,
      },
      db,
    )
    const evaluated = await runProviderBackedGuestAnswerAttributionEvaluation({
      answer: claim.answer,
      evidence: claim.evidence,
      configuration,
      invocationId: claim.request.id,
      ...(signal ? { signal } : {}),
      admissionGuard: () => assertExecutionAllowed({ ...payload, leaseToken }),
      onBeforeFirstDispatch: () =>
        withTenantIsolationBypass(() =>
          markGuestAnswerAttributionEvaluationDispatchedAction({ ...payload, leaseToken }),
        ),
      usageSink: createWorkerAiUsageSink({
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        feature: 'guest-answer-attribution-evaluation',
      }),
      budgetGate: createWorkerAiBudgetGate({
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        feature: 'guest-answer-attribution-evaluation',
      }),
    })
    return await withTenantIsolationBypass(() =>
      completeGuestAnswerAttributionEvaluationRequestAction({
        ...payload,
        leaseToken,
        attribution: evaluated.attribution,
      }),
    )
  } catch (error) {
    await withTenantIsolationBypass(() =>
      failGuestAnswerAttributionEvaluationRequestAction({
        ...payload,
        leaseToken,
        errorCode: boundedErrorCode(error),
      }),
    ).catch((failure) => {
      logger.error({
        action: 'guest-answer-attribution-evaluation.failure-fence-lost',
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        requestId: payload.requestId,
        error: failure instanceof Error ? failure.message : 'Unknown failure',
      })
    })
    throw error
  }
}

/** Recovers only jobs that provably never crossed the provider fence. A lost post-dispatch job
 * becomes AMBIGUOUS and is never automatically sent again. */
export async function recoverGuestAnswerAttributionEvaluations() {
  if (!env.EVALUATION_RUNNER_ENABLED || !(await isEvaluationRuntimeDurablyEnabled(db))) {
    return { recovered: 0, published: 0 }
  }
  const recovered = await withTenantIsolationBypass(() =>
    recoverStaleGuestAnswerAttributionEvaluationRequestsAction({}),
  )
  const candidates = await withTenantIsolationBypass(() =>
    db.guestAnswerAttributionEvaluationRequest.findMany({
      where: { status: 'QUEUED', providerDispatchedAt: null },
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      take: 100,
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        answerHash: true,
        evidenceSetHash: true,
        attemptNumber: true,
      },
    }),
  )
  let published = 0
  for (const request of candidates) {
    if (!(await tenantEnabled(request.tenantId))) continue
    const result = await enqueueGuestAnswerAttributionEvaluation(
      {
        tenantId: request.tenantId,
        venueId: request.venueId,
        requestId: request.id,
        answerHash: request.answerHash,
        evidenceSetHash: request.evidenceSetHash,
      },
      {
        enabled: true,
        ...(request.attemptNumber > 0 ? { dispatchKey: `recovery-${request.attemptNumber}` } : {}),
      },
    )
    if (result.enqueued) published += 1
  }
  return { recovered: recovered.length, published }
}
