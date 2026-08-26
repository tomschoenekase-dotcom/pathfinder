import {
  AiGatewayError,
  generateText,
  type AiMessage,
  type AiSystemBlock,
  type AiTextResult,
  type AiUsageSink,
} from './anthropic'
import type { AiAdmissionGuard } from './admission'
import { withAiRequestBudgetCeiling, type AiBudgetGate } from './budget'
import type { AiModelKey } from './model-registry'
import { AI_MODEL_REGISTRY } from './model-registry'
import type { AiRouteCandidate, AiRoutePlan } from './capability-routing'

export type RoutedAiTextResult<TParsed = string> = AiTextResult<TParsed> & {
  route: {
    capability: AiRoutePlan['capability']
    workloadId: AiRoutePlan['workloadId']
    modelKey: AiModelKey
    fallbackUsed: boolean
  }
}

function textModelKey(candidate: AiRouteCandidate): AiModelKey {
  if (!(candidate.modelKey in AI_MODEL_REGISTRY)) {
    throw new Error(`No text provider adapter is registered for ${candidate.modelKey}`)
  }
  const modelKey = candidate.modelKey as AiModelKey
  if (AI_MODEL_REGISTRY[modelKey].provider !== candidate.provider) {
    throw new Error(`Text provider identity mismatch for ${candidate.modelKey}`)
  }
  return modelKey
}

/** Executes an already-authorized route plan and records route metadata on every attempt. */
export async function generateTextForCapability<TParsed = string>(params: {
  route: AiRoutePlan
  system: AiSystemBlock[]
  messages: AiMessage[]
  maxOutputTokens?: number
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
  usageSink: AiUsageSink
  admissionGuard: AiAdmissionGuard
  budgetGate: AiBudgetGate
  requestBudgetCeilingE8Usd?: string | null
  parseResponse?: (text: string) => TParsed
  invocationId?: string
  onBeforeFirstDispatch?: () => Promise<void>
  signal?: AbortSignal
}): Promise<RoutedAiTextResult<TParsed>> {
  const budgetGate =
    params.requestBudgetCeilingE8Usd === undefined || params.requestBudgetCeilingE8Usd === null
      ? params.budgetGate
      : withAiRequestBudgetCeiling(params.budgetGate, BigInt(params.requestBudgetCeilingE8Usd))
  let lastError: unknown
  let dispatchFencePassed = false
  let budgetAttemptNumberOffset = 0
  for (const candidate of params.route.candidates) {
    const modelKey = textModelKey(candidate)
    try {
      const result = await generateText({
        modelKey,
        system: params.system,
        messages: params.messages,
        usageSink: async (usage) =>
          params.usageSink({
            ...usage,
            capability: params.route.capability,
            requestType: params.route.workloadId,
            routeModelKey: modelKey,
            fallbackUsed: candidate.fallback,
          }),
        admissionGuard: params.admissionGuard,
        budgetGate,
        ...(params.maxOutputTokens !== undefined
          ? { maxOutputTokens: params.maxOutputTokens }
          : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.maxAttempts !== undefined ? { maxAttempts: params.maxAttempts } : {}),
        ...(params.retryDelayMs !== undefined ? { retryDelayMs: params.retryDelayMs } : {}),
        ...(params.parseResponse ? { parseResponse: params.parseResponse } : {}),
        ...(params.invocationId ? { invocationId: params.invocationId } : {}),
        budgetAttemptNumberOffset,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.onBeforeFirstDispatch
          ? {
              onBeforeFirstDispatch: async () => {
                if (dispatchFencePassed) return
                await params.onBeforeFirstDispatch?.()
                dispatchFencePassed = true
              },
            }
          : {}),
      })
      return {
        ...result,
        route: {
          capability: params.route.capability,
          workloadId: params.route.workloadId,
          modelKey,
          fallbackUsed: candidate.fallback,
        },
      }
    } catch (error) {
      lastError = error
      if (params.signal?.aborted) throw error
      // Route fallbacks are for provider/model failures. Admission, budget,
      // policy, accounting, and dispatch-fence failures must fail closed so a
      // second candidate cannot bypass the rejected control.
      if (!(error instanceof AiGatewayError)) throw error
      budgetAttemptNumberOffset += error.attempts
    }
  }
  throw lastError ?? new Error('AI route plan contained no text candidates')
}
