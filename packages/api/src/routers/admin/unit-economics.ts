import { aiCostDecimalToUnits, aiCostUnitsToDecimal } from '@pathfinder/ai'
import {
  db,
  OperatingCostEvidenceActionError,
  recordOperatingCostEvidenceAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_DAYS = 30
const categories = [
  'STORAGE',
  'EMAIL',
  'MEDIA_PROCESSING',
  'INFRASTRUCTURE',
  'OBSERVABILITY',
  'SECURITY',
  'BANDWIDTH',
  'OPERATOR_TIME',
  'OTHER',
] as const

type UnitEconomicsReadClient = Pick<typeof db, 'aiUsageEvent' | 'operatingCostEvidence'>

function sumCostUnits(values: unknown[]) {
  return values.reduce<bigint>((total, value) => total + aiCostDecimalToUnits(value), 0n)
}

function signedCostUnitsToDecimal(units: bigint) {
  return units < 0n ? `-${aiCostUnitsToDecimal(-units)}` : aiCostUnitsToDecimal(units)
}

function partitionEvidence<
  T extends { periodStart: Date; periodEnd: Date; amountUsd: unknown; tenantId: string | null },
>(rows: T[], start: Date, end: Date) {
  const included = rows.filter((row) => row.periodStart >= start && row.periodEnd <= end)
  const platform = included.filter((row) => row.tenantId === null)
  return {
    included,
    totalUnits: sumCostUnits(included.map((row) => row.amountUsd)),
    platformUnits: sumCostUnits(platform.map((row) => row.amountUsd)),
  }
}

export async function readFounderUnitEconomics(
  now = new Date(),
  client: UnitEconomicsReadClient = db,
) {
  const currentStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS)
  const previousStart = new Date(currentStart.getTime() - WINDOW_DAYS * DAY_MS)

  const [currentAiRows, previousAiRows, evidenceRows] = await Promise.all([
    client.aiUsageEvent.groupBy({
      by: ['tenantId'],
      where: { createdAt: { gte: currentStart, lt: now } },
      _sum: { estimatedCostUsd: true },
      _count: { _all: true },
    }),
    client.aiUsageEvent.groupBy({
      by: ['tenantId'],
      where: { createdAt: { gte: previousStart, lt: currentStart } },
      _sum: { estimatedCostUsd: true },
      _count: { _all: true },
    }),
    client.operatingCostEvidence.findMany({
      where: {
        supersededBy: null,
        periodStart: { lt: now },
        periodEnd: { gt: previousStart },
      },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        category: true,
        evidenceKind: true,
        amountUsd: true,
        periodStart: true,
        periodEnd: true,
        sourceSystem: true,
      },
    }),
  ])

  const currentAiUnits = sumCostUnits(currentAiRows.map((row) => row._sum.estimatedCostUsd ?? '0'))
  const previousAiUnits = sumCostUnits(
    previousAiRows.map((row) => row._sum.estimatedCostUsd ?? '0'),
  )
  const currentEvidence = partitionEvidence(evidenceRows, currentStart, now)
  const previousEvidence = partitionEvidence(evidenceRows, previousStart, currentStart)
  const currentTotalUnits = currentAiUnits + currentEvidence.totalUnits
  const previousTotalUnits = previousAiUnits + previousEvidence.totalUnits
  const deltaUnits = currentTotalUnits - previousTotalUnits

  const categoryBreakdown = categories.map((category) => {
    const rows = currentEvidence.included.filter((row) => row.category === category)
    return {
      category,
      represented: rows.length > 0,
      amountUsd: aiCostUnitsToDecimal(sumCostUnits(rows.map((row) => row.amountUsd))),
      entryCount: rows.length,
      evidenceKinds: [...new Set(rows.map((row) => row.evidenceKind))].sort(),
    }
  })
  const excludedOverlappingEvidenceCount = evidenceRows.filter(
    (row) =>
      row.periodStart < now &&
      row.periodEnd > currentStart &&
      !(row.periodStart >= currentStart && row.periodEnd <= now),
  ).length
  const representedCategories = categoryBreakdown
    .filter((entry) => entry.represented)
    .map((entry) => entry.category)
  const unrepresentedCategories = categoryBreakdown
    .filter((entry) => !entry.represented)
    .map((entry) => entry.category)

  return {
    schemaVersion: 'founder-unit-economics.v1' as const,
    generatedAt: now,
    window: {
      days: WINDOW_DAYS,
      start: currentStart,
      endExclusive: now,
      previousStart,
    },
    totals: {
      knownOperatingCostUsd: aiCostUnitsToDecimal(currentTotalUnits),
      priorKnownOperatingCostUsd: aiCostUnitsToDecimal(previousTotalUnits),
      changeUsd: signedCostUnitsToDecimal(deltaUnits),
      changePercent:
        previousTotalUnits > 0n ? Number((deltaUnits * 10_000n) / previousTotalUnits) / 100 : null,
    },
    ai: {
      estimatedCostUsd: aiCostUnitsToDecimal(currentAiUnits),
      requestCount: currentAiRows.reduce((total, row) => total + row._count._all, 0),
      attributedTenantCount: currentAiRows.length,
      completeness: 'PROVIDER_PRICING_ESTIMATE' as const,
    },
    nonAi: {
      evidencedCostUsd: aiCostUnitsToDecimal(currentEvidence.totalUnits),
      platformUnallocatedUsd: aiCostUnitsToDecimal(currentEvidence.platformUnits),
      tenantOrVenueAttributedUsd: aiCostUnitsToDecimal(
        currentEvidence.totalUnits - currentEvidence.platformUnits,
      ),
      evidenceCount: currentEvidence.included.length,
      excludedOverlappingEvidenceCount,
      categories: categoryBreakdown,
    },
    coverage: {
      representedCategories,
      unrepresentedCategories,
      complete: unrepresentedCategories.length === 0 && excludedOverlappingEvidenceCount === 0,
      interpretation:
        'Only current evidence wholly contained in the 30-day window is summed; overlapping periods are excluded rather than prorated.',
    },
    policy: {
      anomalyThreshold: 'UNRESOLVED' as const,
      anomalyClassification: 'NOT_COMPUTED' as const,
      affectsInvoices: false as const,
      affectsCustomerPricing: false as const,
      authorizesServiceCutoff: false as const,
    },
  }
}

const recordInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191).optional(),
    venueId: z.string().trim().min(1).max(191).optional(),
    category: z.enum(categories),
    evidenceKind: z.enum(['OBSERVED', 'ESTIMATED', 'ALLOCATED']),
    amountUsd: z.string().trim().min(1).max(19),
    quantity: z.string().trim().min(1).max(21).optional(),
    quantityUnit: z.string().trim().min(1).max(32).optional(),
    periodStart: z.date(),
    periodEnd: z.date(),
    sourceSystem: z.string().trim().min(1).max(100),
    sourceReference: z.string().trim().min(1).max(191),
    description: z.string().trim().min(1).max(500),
    supersedesId: z.string().uuid().optional(),
  })
  .strict()

function mapActionError(error: unknown): never {
  if (!(error instanceof OperatingCostEvidenceActionError)) throw error
  const code =
    error.code === 'SCOPE_NOT_FOUND'
      ? 'NOT_FOUND'
      : error.code === 'INVALID_INPUT'
        ? 'BAD_REQUEST'
        : 'CONFLICT'
  throw new TRPCError({ code, message: error.message })
}

export const adminUnitEconomicsRouter = router({
  founderUnitEconomics: adminProcedure.query(() =>
    withTenantIsolationBypass(() => readFounderUnitEconomics()),
  ),
  recordOperatingCostEvidence: adminProcedure
    .input(recordInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          recordOperatingCostEvidenceAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          }),
        )
      } catch (error) {
        return mapActionError(error)
      }
    }),
})
