import { z } from 'zod'

import { db } from '../client'

const platformEventSchema = z
  .object({
    eventType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
    sourceSubsystem: z.string().trim().min(1).max(64),
    severity: z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).default('INFO'),
    title: z.string().trim().min(1).max(191),
    summary: z.string().trim().min(1).max(2_000),
    actionRequired: z.boolean().default(false),
    linkedObjectType: z.string().trim().min(1).max(64).optional(),
    linkedObjectId: z.string().trim().min(1).max(191).optional(),
    recommendedAction: z.string().trim().min(1).max(1_000).optional(),
    deduplicationKey: z.string().trim().min(1).max(191),
    expiresAt: z.date().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.linkedObjectType) === Boolean(value.linkedObjectId), {
    message: 'Linked object type and ID must be supplied together.',
  })

export type PublishPlatformOperationalEventInput = z.input<typeof platformEventSchema>

export async function publishPlatformOperationalEvent(args: {
  client?: Pick<typeof db, 'platformOperationalEvent'>
  event: PublishPlatformOperationalEventInput
}) {
  const event = platformEventSchema.parse(args.event)
  const client = args.client ?? db
  return client.platformOperationalEvent.upsert({
    where: { deduplicationKey: event.deduplicationKey },
    create: {
      eventType: event.eventType,
      sourceSubsystem: event.sourceSubsystem,
      severity: event.severity,
      title: event.title,
      summary: event.summary,
      actionRequired: event.actionRequired,
      deduplicationKey: event.deduplicationKey,
      ...(event.linkedObjectType && event.linkedObjectId
        ? { linkedObjectType: event.linkedObjectType, linkedObjectId: event.linkedObjectId }
        : {}),
      ...(event.recommendedAction ? { recommendedAction: event.recommendedAction } : {}),
      ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
    },
    update: {
      occurrenceCount: { increment: 1 },
      lastOccurredAt: new Date(),
      severity: event.severity,
      summary: event.summary,
      actionRequired: event.actionRequired,
      ...(event.recommendedAction ? { recommendedAction: event.recommendedAction } : {}),
    },
    select: { id: true, state: true, occurrenceCount: true },
  })
}
