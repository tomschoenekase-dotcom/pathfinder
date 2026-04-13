import { logger } from '@pathfinder/config/logger'
import { db } from '@pathfinder/db'

import type { AnalyticsEventType } from './events'

export type EmitEventParams = {
  tenantId: string
  venueId: string
  sessionId: string
  eventType: AnalyticsEventType
  placeId?: string
  metadata?: Record<string, unknown>
  occurredAt?: Date
}

export async function emitEvent(params: EmitEventParams): Promise<void> {
  try {
    await db.analyticsEvent.create({
      data: {
        tenantId: params.tenantId,
        venueId: params.venueId,
        sessionId: params.sessionId,
        eventType: params.eventType,
        occurredAt: params.occurredAt ?? new Date(),
        ...(params.placeId !== undefined ? { placeId: params.placeId } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      },
    })
  } catch (error) {
    logger.warn({
      service: '@pathfinder/analytics',
      action: 'analytics.emit-failed',
      tenantId: params.tenantId,
      error: error instanceof Error ? error.message : 'Unknown analytics write error',
      eventType: params.eventType,
      venueId: params.venueId,
    })
  }
}
