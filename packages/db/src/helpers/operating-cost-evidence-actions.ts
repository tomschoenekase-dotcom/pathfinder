import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type OperatingCostEvidenceActionClient = Pick<typeof db, '$transaction'>
type OperatingCostEvidenceTransaction = Pick<
  typeof db,
  'tenant' | 'venue' | 'operatingCostEvidence' | 'auditLog'
>

const decimalSchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(?:\.\d{1,8})?$/, 'Must be a non-negative USD decimal with at most 8 places.')

const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(?:\.\d{1,6})?$/, 'Must be a non-negative quantity with at most 6 places.')

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191).optional(),
    venueId: z.string().trim().min(1).max(191).optional(),
    category: z.enum([
      'STORAGE',
      'EMAIL',
      'MEDIA_PROCESSING',
      'INFRASTRUCTURE',
      'OBSERVABILITY',
      'SECURITY',
      'BANDWIDTH',
      'OPERATOR_TIME',
      'OTHER',
    ]),
    evidenceKind: z.enum(['OBSERVED', 'ESTIMATED', 'ALLOCATED']),
    amountUsd: decimalSchema,
    quantity: quantitySchema.optional(),
    quantityUnit: z.string().trim().min(1).max(32).optional(),
    periodStart: z.date(),
    periodEnd: z.date(),
    sourceSystem: z.string().trim().min(1).max(100),
    sourceReference: z.string().trim().min(1).max(191),
    description: z.string().trim().min(1).max(500),
    supersedesId: z.string().uuid().optional(),
    actor: z
      .object({
        type: z.literal('HUMAN'),
        id: z.string().trim().min(1).max(191),
        role: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.venueId && !input.tenantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantId'],
        message: 'A venue-attributed cost must include its tenant.',
      })
    }
    if ((input.quantity === undefined) !== (input.quantityUnit === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quantity'],
        message: 'Quantity and quantity unit must be supplied together.',
      })
    }
    if (input.periodEnd.getTime() <= input.periodStart.getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodEnd'],
        message: 'The evidence period must end after it starts.',
      })
    }
  })

export type RecordOperatingCostEvidenceInput = z.input<typeof inputSchema>

export class OperatingCostEvidenceActionError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'SCOPE_NOT_FOUND'
      | 'SUPERSESSION_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'OperatingCostEvidenceActionError'
  }
}

const evidenceSelect = {
  id: true,
  operationId: true,
  tenantId: true,
  venueId: true,
  category: true,
  evidenceKind: true,
  amountUsd: true,
  quantity: true,
  quantityUnit: true,
  periodStart: true,
  periodEnd: true,
  sourceSystem: true,
  sourceReference: true,
  description: true,
  supersedesId: true,
  recordedBy: true,
  recordedAt: true,
} as const

type NormalizedInput = z.output<typeof inputSchema>

function sameEvidence(existing: Record<string, unknown>, input: NormalizedInput) {
  const decimal = (value: unknown) => {
    if (value === null || value === undefined) return null
    const [rawInteger = '0', rawFraction = ''] = String(value).split('.')
    const integer = rawInteger.replace(/^0+(?=\d)/, '')
    const fraction = rawFraction.replace(/0+$/, '')
    return fraction ? `${integer}.${fraction}` : integer
  }
  return (
    existing.tenantId === (input.tenantId ?? null) &&
    existing.venueId === (input.venueId ?? null) &&
    existing.category === input.category &&
    existing.evidenceKind === input.evidenceKind &&
    decimal(existing.amountUsd) === decimal(input.amountUsd) &&
    decimal(existing.quantity) === decimal(input.quantity) &&
    existing.quantityUnit === (input.quantityUnit ?? null) &&
    (existing.periodStart as Date).getTime() === input.periodStart.getTime() &&
    (existing.periodEnd as Date).getTime() === input.periodEnd.getTime() &&
    existing.sourceSystem === input.sourceSystem &&
    existing.sourceReference === input.sourceReference &&
    existing.description === input.description &&
    existing.supersedesId === (input.supersedesId ?? null) &&
    existing.recordedBy === input.actor.id
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

async function findReplay(transaction: OperatingCostEvidenceTransaction, input: NormalizedInput) {
  const existing = await transaction.operatingCostEvidence.findUnique({
    where: { operationId: input.operationId },
    select: evidenceSelect,
  })
  if (!existing) return null
  if (!sameEvidence(existing, input)) {
    throw new OperatingCostEvidenceActionError(
      'IDEMPOTENCY_CONFLICT',
      'The operation ID was already used for different cost evidence.',
    )
  }
  return { ...existing, replayed: true as const }
}

/**
 * Appends internal operating-cost evidence. Corrections must supersede prior
 * evidence; this action never changes invoices, customer pricing, budgets, or
 * service availability.
 */
export async function recordOperatingCostEvidenceAction(
  rawInput: RecordOperatingCostEvidenceInput,
  client: OperatingCostEvidenceActionClient = db,
) {
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new OperatingCostEvidenceActionError(
      'INVALID_INPUT',
      'Operating cost evidence is invalid.',
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
          throw new OperatingCostEvidenceActionError(
            'SCOPE_NOT_FOUND',
            'The tenant for this cost evidence does not exist.',
          )
        }
      }

      if (input.venueId) {
        const tenantId = input.tenantId
        if (!tenantId) {
          throw new OperatingCostEvidenceActionError(
            'INVALID_INPUT',
            'A venue-attributed cost must include its tenant.',
          )
        }
        const venue = await transaction.venue.findFirst({
          where: { id: input.venueId, tenantId },
          select: { id: true },
        })
        if (!venue) {
          throw new OperatingCostEvidenceActionError(
            'SCOPE_NOT_FOUND',
            'The venue for this cost evidence does not belong to the supplied tenant.',
          )
        }
      }

      if (input.supersedesId) {
        const prior = await transaction.operatingCostEvidence.findFirst({
          where: { id: input.supersedesId, supersededBy: null },
          select: { id: true, tenantId: true, venueId: true, category: true, sourceSystem: true },
        })
        if (
          !prior ||
          prior.tenantId !== (input.tenantId ?? null) ||
          prior.venueId !== (input.venueId ?? null) ||
          prior.category !== input.category ||
          prior.sourceSystem !== input.sourceSystem
        ) {
          throw new OperatingCostEvidenceActionError(
            'SUPERSESSION_CONFLICT',
            'Only current evidence from the same scope, category, and source may be superseded.',
          )
        }
      }

      const created = await transaction.operatingCostEvidence.create({
        data: {
          operationId: input.operationId,
          tenantId: input.tenantId ?? null,
          venueId: input.venueId ?? null,
          category: input.category,
          evidenceKind: input.evidenceKind,
          amountUsd: input.amountUsd,
          quantity: input.quantity ?? null,
          quantityUnit: input.quantityUnit ?? null,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          sourceSystem: input.sourceSystem,
          sourceReference: input.sourceReference,
          description: input.description,
          supersedesId: input.supersedesId ?? null,
          recordedBy: input.actor.id,
        },
        select: evidenceSelect,
      })

      await writeAuditLogStrict(
        {
          tenantId: input.tenantId ?? null,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'operating-cost-evidence.recorded',
          targetType: 'OperatingCostEvidence',
          targetId: created.id,
          afterState: {
            scope: input.venueId ? 'VENUE' : input.tenantId ? 'TENANT' : 'PLATFORM',
            category: input.category,
            evidenceKind: input.evidenceKind,
            amountUsd: input.amountUsd,
            periodStart: input.periodStart.toISOString(),
            periodEnd: input.periodEnd.toISOString(),
            sourceSystem: input.sourceSystem,
            sourceReference: input.sourceReference,
            supersedesId: input.supersedesId ?? null,
            affectsInvoices: false,
            affectsCustomerPricing: false,
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
    if (error instanceof OperatingCostEvidenceActionError || !isUniqueConflict(error)) throw error
    return client.$transaction(async (transaction) => {
      const replay = await findReplay(transaction, input)
      if (replay) return replay
      throw new OperatingCostEvidenceActionError(
        'SUPERSESSION_CONFLICT',
        'Cost evidence changed concurrently; refresh before retrying.',
      )
    })
  }
}
