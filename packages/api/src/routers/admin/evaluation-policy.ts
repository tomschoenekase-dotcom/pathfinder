import { AI_MODEL_KEYS, getAiModelSpec, textAttemptCostCeilingUnits } from '@pathfinder/ai'

export const MAX_EVALUATION_RUN_CASES = 50

// One complete 20-case launch-language observation on the more expensive
// allow-listed guest route reserves $4.0512. Keep a narrow rounding margin while
// rejecting broader per-run spend.
export const MAX_EVALUATION_RUN_BUDGET_E8_USD = 410_000_000n

export const EVALUATION_MODEL_KEYS = [
  AI_MODEL_KEYS.GUEST_CHAT,
  AI_MODEL_KEYS.GUEST_CHAT_OPENAI,
] as const

export function evaluationModelBudgetCeilingsE8Usd() {
  return Object.fromEntries(
    EVALUATION_MODEL_KEYS.map((modelKey) => {
      const spec = getAiModelSpec(modelKey)
      return [
        modelKey,
        textAttemptCostCeilingUnits({
          spec,
          system: [],
          messages: [],
          maxOutputTokens: spec.maxOutputTokens,
        }).toString(),
      ]
    }),
  ) as Record<(typeof EVALUATION_MODEL_KEYS)[number], string>
}
