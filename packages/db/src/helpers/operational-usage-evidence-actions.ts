import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type OperationalUsageEvidenceActionClient = Pick<typeof db, '$transaction'>
type OperationalUsageEvidenceTransaction = Pick<
  typeof db,
  'tenant' | 'venue' | 'operationalUsageEvidence' | 'auditLog'
>

const metricUnits = {
  INTAKE_DECLARED_BYTES: 'BYTES',
  MEDIA_DECLARED_BYTES: 'BYTES',
  QUEUE_DEPTH: 'JOBS',
  QUEUE_FAILED_JOBS: 'JOBS',
  QUEUE_OLDEST_AGE_MILLISECONDS: 'MILLISECONDS',
} as const

const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(?:\.\d{1,6})?$/, 'Must be a non-negative quantity with at most 6 places.')

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191).optional(),
    venueId: z.string().trim().min(1).max(191).optional(),
    metric: z.enum([
      'INTAKE_DECLARED_BYTES',
      'MEDIA_DECLARED_BYTES',
      'QUEUE_DEPTH',
      'QUEUE_FAILED_JOBS',
      'QUEUE_OLDEST_AGE_MILLISECONDS',
    ]),
    measurementKind: z.literal('GAUGE'),
    quantity: quantitySchema,
    unit: z.enum(['BYTES', 'JOBS', 'MILLISECONDS']),
    observedAt: z.date(),
    periodStart: z.date().optional(),
    periodEnd: z.date().optional(),
    sourceSystem: z.string().trim().min(1).max(100),
    sourceReference: z.string().trim().min(1).max(191),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    actor: z.union([
      z
        .object({
          type: z.literal('HUMAN'),
          id: z.string().trim().min(1).max(191),
          role: z.literal('PLATFORM_ADMIN'),
        })
        .strict(),
      z
        .object({
          type: z.literal('SYSTEM'),
          id: z.string().trim().min(1).max(191),
          role: z.literal('SYSTEM'),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.venueId && !input.tenantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantId'],
        message: 'A venue-scoped observation must include its tenant.',
      })
    }
    if (metricUnits[input.metric] !== input.unit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unit'],
        message: 'The unit does not match the operational usage metric.',
      })
    }
    const hasStart = input.periodStart !== undefined
    const hasEnd = input.periodEnd !== undefined
    if (input.measurementKind === 'GAUGE' && (hasStart || hasEnd)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodStart'],
        message: 'Gauge observations must not include an interval.',
      })
    }
  })

export type RecordOperationalUsageEvidenceInput = z.input<typeof inputSchema>

export class OperationalUsageEvidenceActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'SCOPE_NOT_FOUND' | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'OperationalUsageEvidenceActionError'
  }
}

const evidenceSelect = {
  id: true,
  operationId: true,
  tenantId: true,
  venueId: true,
  metric: true,
  measurementKind: true,
  quantity: true,
  unit: true,
  observedAt: true,
  periodStart: true,
  periodEnd: true,
  sourceSystem: true,
  sourceReference: true,
  sourceDigest: true,
  recordedByType: true,
  recordedById: true,
  recordedAt: true,
} as const

type NormalizedInput = z.output<typeof inputSchema>

function normalizeDecimal(value: unknown) {
  const [rawInteger = '0', rawFraction = ''] = String(value).split('.')
  const integer = rawInteger.replace(/^0+(?=\d)/, '')
  const fraction = rawFraction.replace(/0+$/, '')
  return fraction ? `${integer}.${fraction}` : integer
}

function sameInstant(value: unknown, expected: Date | undefined) {
  if (value === null || value === undefined) return expected === undefined
  return value instanceof Date && expected !== undefined && value.getTime() === expected.getTime()
}

function sameEvidence(existing: Record<string, unknown>, input: NormalizedInput) {
  return (
    existing.tenantId === (input.tenantId ?? null) &&
    existing.venueId === (input.venueId ?? null) &&
    existing.metric === input.metric &&
    existing.measurementKind === input.measurementKind &&
    normalizeDecimal(existing.quantity) === normalizeDecimal(input.quantity) &&
    existing.unit === input.unit &&
    sameInstant(existing.observedAt, input.observedAt) &&
    sameInstant(existing.periodStart, input.periodStart) &&
    sameInstant(existing.periodEnd, input.periodEnd) &&
    existing.sourceSystem === input.sourceSystem &&
    existing.sourceReference === input.sourceReference &&
    existing.sourceDigest === input.sourceDigest &&
    existing.recordedByType === input.actor.type &&
    existing.recordedById === input.actor.id
  )
}

function isUniqueConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

async function findReplay(
  transaction: OperationalUsageEvidenceTransaction,
  input: NormalizedInput,
) {
  const existing = await transaction.operationalUsageEvidence.findUnique({
    where: { operationId: input.operationId },
    select: evidenceSelect,
  })
  if (!existing) return null
  if (!sameEvidence(existing, input)) {
    throw new OperationalUsageEvidenceActionError(
      'IDEMPOTENCY_CONFLICT',
      'The operation ID was already used for different usage evidence.',
    )
  }
  return { ...existing, replayed: true as const }
}

/**
 * Appends measured operational quantities without assigning a dollar value,
 * changing customer pricing, defining an anomaly, or affecting service.
 */
export async function recordOperationalUsageEvidenceAction(
  rawInput: RecordOperationalUsageEvidenceInput,
  client: OperationalUsageEvidenceActionClient = db,
) {
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new OperationalUsageEvidenceActionError(
      'INVALID_INPUT',
      'Operational usage evidence is invalid.',
    )
  }
  const input = parsed.data

  const attempt = () =>
    client.$transaction(async (transaction) => {
      const replay = await findReplay(transaction, input)
      if (replay) return replay

      if (input.tenantId) {
        const tenant = await transaction.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true },
        })
        if (!tenant) {
          throw new OperationalUsageEvidenceActionError(
            'SCOPE_NOT_FOUND',
            'The tenant for this usage evidence does not exist.',
          )
        }
      }

      if (input.venueId) {
        const venue = await transaction.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId! },
          select: { id: true },
        })
        if (!venue) {
          throw new OperationalUsageEvidenceActionError(
            'SCOPE_NOT_FOUND',
            'The venue for this usage evidence does not belong to the supplied tenant.',
          )
        }
      }

      const created = await transaction.operationalUsageEvidence.create({
        data: {
          operationId: input.operationId,
          tenantId: input.tenantId ?? null,
          venueId: input.venueId ?? null,
          metric: input.metric,
          measurementKind: input.measurementKind,
          quantity: input.quantity,
          unit: input.unit,
          observedAt: input.observedAt,
          periodStart: input.periodStart ?? null,
          periodEnd: input.periodEnd ?? null,
          sourceSystem: input.sourceSystem,
          sourceReference: input.sourceReference,
          sourceDigest: input.sourceDigest,
          recordedByType: input.actor.type,
          recordedById: input.actor.id,
        },
        select: evidenceSelect,
      })

      await writeAuditLogStrict(
        {
          tenantId: input.tenantId ?? null,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'operational-usage-evidence.recorded',
          targetType: 'OperationalUsageEvidence',
          targetId: created.id,
          afterState: {
            scope: input.venueId ? 'VENUE' : input.tenantId ? 'TENANT' : 'PLATFORM',
            metric: input.metric,
            measurementKind: input.measurementKind,
            quantity: input.quantity,
            unit: input.unit,
            observedAt: input.observedAt.toISOString(),
            sourceSystem: input.sourceSystem,
            sourceReference: input.sourceReference,
            assignsDollarValue: false,
            affectsCustomerPricing: false,
            definesAnomalyThreshold: false,
            authorizesServiceCutoff: false,
          },
        },
        transaction,
      )

      return { ...created, replayed: false as const }
    })

  try {
    return await attempt()
  } catch (error) {
    if (error instanceof OperationalUsageEvidenceActionError || !isUniqueConflict(error)) {
      throw error
    }
    return client.$transaction(async (transaction) => {
      const replay = await findReplay(transaction, input)
      if (replay) return replay
      throw new OperationalUsageEvidenceActionError(
        'IDEMPOTENCY_CONFLICT',
        'Usage evidence changed concurrently; retry with a new operation ID.',
      )
    })
  }
}
