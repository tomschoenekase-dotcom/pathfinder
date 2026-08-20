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

export async function recordOperationalEventDeliveryAttempt(input: {
  deliveryId: string
  tenantId: string
  attemptNumber: number
  status: 'SENT' | 'FAILED' | 'SUPPRESSED'
  provider: string
  providerRef?: string
  errorCode?: string
  nextAttemptAt?: Date
}) {
  return db.$transaction(async (transaction) => {
    await transaction.operationalEventDeliveryAttempt.create({
      data: {
        deliveryId: input.deliveryId,
        tenantId: input.tenantId,
        attemptNumber: input.attemptNumber,
        status: input.status,
        provider: input.provider,
        ...(input.providerRef ? { providerRef: input.providerRef } : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      },
    })
    return transaction.operationalEventDelivery.update({
      where: { id: input.deliveryId, tenantId: input.tenantId },
      data: {
        status: input.status,
        attemptCount: input.attemptNumber,
        lastErrorCode: input.errorCode ?? null,
        nextAttemptAt: input.nextAttemptAt ?? null,
        ...(input.status === 'SENT' ? { sentAt: new Date() } : {}),
      },
    })
  })
}
