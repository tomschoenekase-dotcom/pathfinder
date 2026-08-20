import { z } from 'zod'

import { db } from '../client'

const signalSchema = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    sessionId: z.string().min(1).max(191),
    guestChatTurnId: z.string().uuid(),
    category: z.enum([
      'VISITOR_INTENT',
      'NAVIGATION_REQUEST',
      'UNANSWERED_QUESTION',
      'LOW_CONFIDENCE_ANSWER',
      'KNOWLEDGE_GAP',
      'CONFUSION_POINT',
      'COMPLAINT',
      'COMPLIMENT',
      'ACCESSIBILITY_CONCERN',
      'AMENITY_REQUEST',
      'EXHIBIT_INTEREST',
      'PURCHASE_INTENT',
      'STAFF_ASSISTANCE_NEEDED',
      'CONTENT_UPDATE_CANDIDATE',
      'SENTIMENT_SIGNAL',
    ]),
    confidence: z.number().min(0).max(1),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('INFO'),
    summary: z.string().trim().min(1).max(1000),
    suggestedAction: z.string().trim().min(1).max(1000).optional(),
    evidenceMessageIds: z.array(z.string().min(1).max(191)).max(20).default([]),
    capability: z.string().trim().min(1).max(64),
    provider: z.string().trim().min(1).max(32),
    model: z.string().trim().min(1).max(191),
    analyzerVersion: z.string().trim().min(1).max(64),
  })
  .strict()

export type ConversationInsightSignal = z.input<typeof signalSchema>

/**
 * Persists bounded insight records idempotently. The caller must derive ownership
 * from an already-authorized session/turn; this helper never accepts client-owned scope.
 */
export async function recordConversationInsightSignals(args: {
  client?: Pick<typeof db, 'conversationInsight'>
  signals: ConversationInsightSignal[]
}): Promise<{ created: number }> {
  if (args.signals.length === 0) return { created: 0 }
  const signals = z.array(signalSchema).min(1).max(25).parse(args.signals)
  const client = args.client ?? db
  const created = await client.conversationInsight.createMany({
    data: signals.map((signal) => ({
      tenantId: signal.tenantId,
      venueId: signal.venueId,
      sessionId: signal.sessionId,
      guestChatTurnId: signal.guestChatTurnId,
      category: signal.category,
      confidence: signal.confidence,
      severity: signal.severity,
      summary: signal.summary,
      ...(signal.suggestedAction ? { suggestedAction: signal.suggestedAction } : {}),
      evidenceMessageIds: signal.evidenceMessageIds,
      capability: signal.capability,
      provider: signal.provider,
      model: signal.model,
      analyzerVersion: signal.analyzerVersion,
    })),
    skipDuplicates: true,
  })
  return { created: created.count }
}
