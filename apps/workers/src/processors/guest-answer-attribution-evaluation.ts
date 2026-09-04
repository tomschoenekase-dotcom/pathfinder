import { randomUUID } from 'node:crypto'

import {
  AiGatewayError,
  AiRequestBudgetCeilingExceededError,
  AiRoutingError,
  AI_CENTRAL_MODEL_REGISTRY,
} from '@pathfinder/ai'
import { env, logger } from '@pathfinder/config'
import {
  assertVenueAiAvailable,
  claimGuestAnswerAttributionEvaluationRequestAction,
  completeGuestAnswerAttributionEvaluationRequestAction,
  db,
  failGuestAnswerAttributionEvaluationRequestAction,
  type GuestAnswerAttributionEvaluationFailureCode,
  getEvaluationRuntimeAuthorization,
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
  providerCandidates: string[]
  requestBudgetCeilingE8Usd: string | null
}) {
  if (!env.EVALUATION_RUNNER_ENABLED) throw new Error('Evaluation runtime is disabled')
  const [authorization, enabled] = await Promise.all([
    getEvaluationRuntimeAuthorization(db),
    tenantEnabled(input.tenantId),
  ])
  if (!authorization || authorization.tenantId !== input.tenantId || !enabled)
    throw new Error('Evaluation policy gate is disabled')
  if (
    input.providerCandidates.length === 0 ||
    input.providerCandidates.some(
      (provider) => !authorization.allowedProviders.includes(provider as never),
    )
  ) {
    throw new Error('Evaluation provider is outside the active authorization')
  }
  if (
    input.requestBudgetCeilingE8Usd === null ||
    !/^\d+$/u.test(input.requestBudgetCeilingE8Usd) ||
    BigInt(input.requestBudgetCeilingE8Usd) > authorization.maxBudgetE8Usd
  ) {
    throw new Error('Evaluation budget exceeds the active authorization ceiling')
  }
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
      select: { id: true, queuedAt: true },
    }),
  )
  if (!owned) throw new Error('Guest answer evaluation lease is unavailable')
  if (
    !owned.queuedAt ||
    owned.queuedAt < authorization.authorizedAt ||
    owned.queuedAt > authorization.expiresAt
  ) {
    throw new Error('Guest answer evaluation was not queued in the active authorization window')
  }
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
  const initialAuthorization = await getEvaluationRuntimeAuthorization(db)
  if (
    initialAuthorization?.tenantId !== payload.tenantId ||
    !(await tenantEnabled(payload.tenantId))
  ) {
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
    const providerCandidates = [
      AI_CENTRAL_MODEL_REGISTRY[configuration.primaryModelKey].provider,
      ...(configuration.fallback.enabled
        ? configuration.fallback.modelKeys.map(
            (modelKey) => AI_CENTRAL_MODEL_REGISTRY[modelKey].provider,
          )
        : []),
    ]
    const evaluated = await runProviderBackedGuestAnswerAttributionEvaluation({
      answer: claim.answer,
      evidence: claim.evidence,
      configuration,
      invocationId: claim.request.id,
      ...(signal ? { signal } : {}),
      admissionGuard: () =>
        assertExecutionAllowed({
          ...payload,
          leaseToken,
          providerCandidates: [...new Set(providerCandidates)],
          requestBudgetCeilingE8Usd: configuration.requestBudgetCeilingE8Usd,
        }),
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
  const authorization = await getEvaluationRuntimeAuthorization(db)
  if (!env.EVALUATION_RUNNER_ENABLED || !authorization) {
    return { recovered: 0, published: 0 }
  }
  const recovered = await withTenantIsolationBypass(() =>
    recoverStaleGuestAnswerAttributionEvaluationRequestsAction({}),
  )
  const candidates = await withTenantIsolationBypass(() =>
    db.guestAnswerAttributionEvaluationRequest.findMany({
      where: {
        tenantId: authorization.tenantId,
        status: 'QUEUED',
        providerDispatchedAt: null,
        queuedAt: { gte: authorization.authorizedAt, lte: authorization.expiresAt },
      },
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
