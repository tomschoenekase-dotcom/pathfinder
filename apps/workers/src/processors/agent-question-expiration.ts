import { logger } from '@pathfinder/config'
import { expireAgentQuestionsAction } from '@pathfinder/db'

const EXPIRATION_BATCH_LIMIT = 100

/**
 * Performs the bounded canonical expiration scan. It neither dispatches an
 * agent nor calls a provider; the action owns question state and audit writes.
 */
export async function processAgentQuestionExpiration() {
  const result = await expireAgentQuestionsAction({ limit: EXPIRATION_BATCH_LIMIT })
  logger.info({
    action: 'workers.agent-question-expiration.completed',
    scanned: result.scanned,
    expired: result.expired,
    skipped: result.skipped,
  })
  return result
}
