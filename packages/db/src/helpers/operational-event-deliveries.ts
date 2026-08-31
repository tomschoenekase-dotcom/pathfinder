import { createHash } from 'node:crypto'
import { z } from 'zod'

import { db } from '../client'

const severityRank = { INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 } as const

export const OperationalEventRoutingPolicy = z
  .object({
    channel: z.enum(['EMAIL', 'SLACK', 'WEBHOOK']),
    destination: z.string().trim().min(1).max(500),
    minimumSeverity: z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).default('ERROR'),
  })
  .strict()

export type OperationalEventRoutingPolicy = z.infer<typeof OperationalEventRoutingPolicy>

const operationalEventDeliveryAttempt = z.discriminatedUnion('status', [
  z
    .object({
      deliveryId: z.string().trim().min(1),
      tenantId: z.string().trim().min(1),
      attemptNumber: z.number().int().positive(),
      status: z.literal('SENT'),
      provider: z.string().trim().min(1).max(100),
      providerRef: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      deliveryId: z.string().trim().min(1),
      tenantId: z.string().trim().min(1),
      attemptNumber: z.number().int().positive(),
      status: z.literal('FAILED'),
      provider: z.string().trim().min(1).max(100),
      errorCode: z.literal('PROVIDER_FAILURE'),
      nextAttemptAt: z.date(),
    })
    .strict(),
  z
    .object({
      deliveryId: z.string().trim().min(1),
      tenantId: z.string().trim().min(1),
      attemptNumber: z.number().int().positive(),
      status: z.literal('SUPPRESSED'),
      provider: z.string().trim().min(1).max(100),
      errorCode: z.literal('RETRY_EXHAUSTED'),
    })
    .strict(),
])

export type OperationalEventDeliveryAttemptInput = z.infer<typeof operationalEventDeliveryAttempt>

export function operationalEventDestinationKey(policy: OperationalEventRoutingPolicy): string {
  return createHash('sha256')
    .update(
      JSON.stringify(['operational-event-destination-v1', policy.channel, policy.destination]),
    )
    .digest('hex')
}

export async function materializeOperationalEventDeliveries(
  input: OperationalEventRoutingPolicy,
  client = db,
) {
  const policy = OperationalEventRoutingPolicy.parse(input)
  const destinationKey = operationalEventDestinationKey(policy)
  const severities = (Object.keys(severityRank) as Array<keyof typeof severityRank>).filter(
    (severity) => severityRank[severity] >= severityRank[policy.minimumSeverity],
  )
  const events = await client.operationalEvent.findMany({
    where: {
      state: 'OPEN',
      severity: { in: severities },
      deliveries: { none: { channel: policy.channel, destinationKey } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100,
    select: { id: true, tenantId: true },
  })
  await Promise.all(
    events.map((event) =>
      client.operationalEventDelivery.upsert({
        where: {
          eventId_channel_destinationKey: {
            eventId: event.id,
            channel: policy.channel,
            destinationKey,
          },
        },
        create: {
          tenantId: event.tenantId,
          eventId: event.id,
          channel: policy.channel,
          destinationKey,
        },
        update: {},
      }),
    ),
  )
  return { destinationKey, created: events.length }
}

export async function readNextOperationalEventDelivery(input: {
  channel: 'EMAIL' | 'SLACK' | 'WEBHOOK'
  destinationKey: string
  now?: Date
}) {
  const now = input.now ?? new Date()
  return db.operationalEventDelivery.findFirst({
    where: {
      channel: input.channel,
      destinationKey: input.destinationKey,
      status: { in: ['PENDING', 'FAILED'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    include: { event: true },
  })
}

export async function recordOperationalEventDeliveryAttempt(
  input: OperationalEventDeliveryAttemptInput,
  client = db,
) {
  const attempt = operationalEventDeliveryAttempt.parse(input)
  return client.$transaction(async (transaction) => {
    await transaction.operationalEventDeliveryAttempt.create({
      data: {
        deliveryId: attempt.deliveryId,
        tenantId: attempt.tenantId,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        provider: attempt.provider,
        ...(attempt.status === 'SENT' && attempt.providerRef
          ? { providerRef: attempt.providerRef }
          : {}),
        ...('errorCode' in attempt ? { errorCode: attempt.errorCode } : {}),
      },
    })
    return transaction.operationalEventDelivery.update({
      where: { id: attempt.deliveryId, tenantId: attempt.tenantId },
      data: {
        status: attempt.status,
        attemptCount: attempt.attemptNumber,
        lastErrorCode: 'errorCode' in attempt ? attempt.errorCode : null,
        nextAttemptAt: 'nextAttemptAt' in attempt ? attempt.nextAttemptAt : null,
        ...(attempt.status === 'SENT' ? { sentAt: new Date() } : {}),
      },
    })
  })
}
