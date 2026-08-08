import type { AiUsageSink } from '@pathfinder/ai'
import { logger } from '@pathfinder/config'

import type { TRPCContext } from '../context'

type UsageClient = Pick<TRPCContext['db'], 'aiUsageEvent'>

export function createApiAiUsageRecorder(params: {
  db: UsageClient
  tenantId: string
  venueId: string
  feature: string
  surface: string
}) {
  const usageEventIds: string[] = []
  let persistenceFailed = false

  const sink: AiUsageSink = async (usage) => {
    try {
      const event = await params.db.aiUsageEvent.create({
        data: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          feature: params.feature,
          surface: params.surface,
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
        select: { id: true },
      })
      usageEventIds.push(event.id)
    } catch {
      persistenceFailed = true
      logger.error({
        action: 'api.ai_usage.persistence_failed',
        tenantId: params.tenantId,
        venueId: params.venueId,
        feature: params.feature,
        error: 'AI usage persistence failed',
      })
      throw new Error('AI usage persistence failed')
    }
  }

  return {
    sink,
    usageEventIds: () => [...usageEventIds],
    persistenceFailed: () => persistenceFailed,
  }
}
