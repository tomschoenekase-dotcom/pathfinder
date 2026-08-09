import { AiCostBudgetExceededError, AiCostBudgetUnavailableError } from './ai-cost-budgets'
import { GlobalAiAdmissionError } from './incident-control'
import { VenueUnavailableError } from './venue-availability'

export function isAiAdmissionControlError(error: unknown): boolean {
  return (
    error instanceof GlobalAiAdmissionError ||
    error instanceof VenueUnavailableError ||
    error instanceof AiCostBudgetExceededError ||
    error instanceof AiCostBudgetUnavailableError
  )
}
