import { z } from 'zod'

import { db } from '../client'

const publishSchema = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191).optional(),
    eventType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
    sourceSubsystem: z.string().trim().min(1).max(64),
    severity: z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).default('INFO'),
    title: z.string().trim().min(1).max(191),
    summary: z.string().trim().min(1).max(2000),
    actionRequired: z.boolean().default(false),
    linkedObjectType: z.string().trim().min(1).max(64).optional(),
    linkedObjectId: z.string().trim().min(1).max(191).optional(),
    recommendedAction: z.string().trim().min(1).max(1000).optional(),
    deduplicationKey: z.string().trim().min(1).max(191),
    expiresAt: z.date().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.linkedObjectType) === Boolean(value.linkedObjectId), {
    message: 'Linked object type and ID must be supplied together.',
  })

export type PublishOperationalEventInput = z.input<typeof publishSchema>

/** Publishes or groups an operationally meaningful event. Raw telemetry and conversation text do not belong here. */
export async function publishOperationalEvent(args: {
  client?: Pick<typeof db, 'operationalEvent'>
  event: PublishOperationalEventInput
}) {
  const event = publishSchema.parse(args.event)
  const client = args.client ?? db
  return client.operationalEvent.upsert({
    where: {
      tenantId: event.tenantId,
      tenantId_deduplicationKey: {
        tenantId: event.tenantId,
        deduplicationKey: event.deduplicationKey,
      },
    },
    create: {
      tenantId: event.tenantId,
      ...(event.venueId ? { venueId: event.venueId } : {}),
      eventType: event.eventType,
      sourceSubsystem: event.sourceSubsystem,
      severity: event.severity,
      title: event.title,
      summary: event.summary,
      actionRequired: event.actionRequired,
      ...(event.linkedObjectType && event.linkedObjectId
        ? { linkedObjectType: event.linkedObjectType, linkedObjectId: event.linkedObjectId }
        : {}),
      ...(event.recommendedAction ? { recommendedAction: event.recommendedAction } : {}),
      deduplicationKey: event.deduplicationKey,
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
