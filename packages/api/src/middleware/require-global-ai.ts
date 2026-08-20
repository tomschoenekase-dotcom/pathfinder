import { GLOBAL_AI_UNAVAILABLE_MESSAGE } from '@pathfinder/config/incident-control'
import { logger } from '@pathfinder/config/logger'
import { assertGlobalAiAvailable } from '@pathfinder/db'

import { publicTRPCError, t } from '../core'

export const requireGlobalAi = t.middleware(async ({ ctx, next }) => {
  try {
    await assertGlobalAiAvailable(ctx.db)
  } catch (error) {
    logger.warn({
      action: 'global-ai.admission-denied',
      cause:
        error instanceof Error && error.name === 'GlobalAiAdmissionError'
          ? 'control-denied'
          : 'control-unavailable',
    })
    throw publicTRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: GLOBAL_AI_UNAVAILABLE_MESSAGE,
      publicCode: 'PROVIDER_UNAVAILABLE',
    })
  }

  return next()
})
