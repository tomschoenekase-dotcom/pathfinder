import { AiCostBudgetExceededError, AiCostBudgetUnavailableError } from './ai-cost-budgets'
import { GlobalAiAdmissionError } from './incident-control'

export function isAiAdmissionControlError(error: unknown): boolean {
  return (
    error instanceof GlobalAiAdmissionError ||
    error instanceof AiCostBudgetExceededError ||
    error instanceof AiCostBudgetUnavailableError
  )
}
