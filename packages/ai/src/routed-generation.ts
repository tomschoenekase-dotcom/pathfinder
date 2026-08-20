import {
  generateText,
  type AiMessage,
  type AiSystemBlock,
  type AiTextResult,
  type AiUsageSink,
} from './anthropic'
import type { AiAdmissionGuard } from './admission'
import type { AiBudgetGate } from './budget'
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
  if (candidate.provider !== 'anthropic' || !(candidate.modelKey in AI_MODEL_REGISTRY)) {
    throw new Error(`No text provider adapter is registered for ${candidate.modelKey}`)
  }
  return candidate.modelKey as AiModelKey
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
  parseResponse?: (text: string) => TParsed
  onBeforeFirstDispatch?: () => Promise<void>
  signal?: AbortSignal
}): Promise<RoutedAiTextResult<TParsed>> {
  let lastError: unknown
  let dispatchFencePassed = false
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
        budgetGate: params.budgetGate,
        ...(params.maxOutputTokens !== undefined
          ? { maxOutputTokens: params.maxOutputTokens }
          : {}),
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.maxAttempts !== undefined ? { maxAttempts: params.maxAttempts } : {}),
        ...(params.retryDelayMs !== undefined ? { retryDelayMs: params.retryDelayMs } : {}),
        ...(params.parseResponse ? { parseResponse: params.parseResponse } : {}),
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
    }
  }
  throw lastError ?? new Error('AI route plan contained no text candidates')
}
