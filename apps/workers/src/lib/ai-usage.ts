import type { AiUsageSink } from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import { db } from '@pathfinder/db'

export function createWorkerAiUsageSink(params: {
  tenantId: string
  venueId: string
  feature: string
}): AiUsageSink {
  return async (usage) => {
    try {
      await db.aiUsageEvent.create({
        data: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          feature: params.feature,
          surface: 'worker',
          provider: usage.provider,
          model: usage.model,
          pricingVersion: usage.pricingVersion,
          inputTokens: usage.usage.inputTokens,
          outputTokens: usage.usage.outputTokens,
          cacheCreationInputTokens: usage.usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.usage.cacheReadInputTokens,
          totalTokens:
            usage.usage.inputTokens +
            usage.usage.outputTokens +
            usage.usage.cacheCreationInputTokens +
            usage.usage.cacheReadInputTokens,
          estimatedCostUsd: usage.estimatedCostUsd,
          latencyMs: usage.latencyMs,
          attempts: usage.attempts,
          success: usage.success,
          ...(usage.errorCode ? { errorCode: usage.errorCode } : {}),
        },
      })
    } catch (error) {
      logger.error({
        action: 'workers.ai_usage.failed',
        tenantId: params.tenantId,
        venueId: params.venueId,
        feature: params.feature,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }
}
