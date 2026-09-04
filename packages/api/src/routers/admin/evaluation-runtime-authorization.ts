import type { EvaluationRuntimeAuthorization } from '@pathfinder/db'
import { TRPCError } from '@trpc/server'

export const EVALUATION_RUNNER_FLAG = 'evaluation-runner-v1'

export function authorizeEvaluation(
  authorization: EvaluationRuntimeAuthorization,
  provider: string,
  budgetE8Usd: bigint,
) {
  if (!authorization.allowedProviders.includes(provider as never))
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The selected provider is outside the active evaluation authorization',
    })
  if (budgetE8Usd > authorization.maxBudgetE8Usd)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Evaluation budget exceeds the active authorization ceiling',
    })
  return {
    authorizationId: authorization.authorizationId,
    authorizedAt: authorization.authorizedAt.toISOString(),
    expiresAt: authorization.expiresAt.toISOString(),
    maxBudgetE8Usd: authorization.maxBudgetE8Usd.toString(),
    allowedProviders: authorization.allowedProviders,
  }
}
