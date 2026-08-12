import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { NativeVenueDeploymentError } from '@pathfinder/db'

export type NativeStatus = 'DRAFT' | 'APPROVED' | 'APPLIED' | 'REVERTED'

export const coverage = [
  { section: 'VENUE_CONFIGURATION', disposition: 'SUPPORTED' },
  { section: 'PLACES', disposition: 'SUPPORTED' },
  { section: 'KNOWLEDGE', disposition: 'SUPPORTED' },
  { section: 'GENERALIZED_MODULES', disposition: 'SUPPORTED' },
  { section: 'ITEMS', disposition: 'SUPPORTED_EMPTY_ONLY' },
  { section: 'ASSETS', disposition: 'SUPPORTED_EMPTY_ONLY' },
  { section: 'CAPABILITY_MODEL_REFERENCES', disposition: 'SUPPORTED_EMPTY_ONLY' },
] as const

export function actionGates(
  status: NativeStatus,
  updatedAt: Date | string,
  releaseId?: unknown,
  currentHeadReleaseId?: string | null,
) {
  const expectedUpdatedAt =
    updatedAt instanceof Date ? updatedAt.toISOString() : new Date(updatedAt).toISOString()
  return {
    approve: {
      allowed: status === 'DRAFT',
      reason: status === 'DRAFT' ? null : 'Only a draft release can be approved.',
    },
    apply: {
      allowed: status === 'APPROVED',
      reason: status === 'APPROVED' ? null : 'Only an approved release can be applied.',
    },
    revert: {
      allowed:
        status === 'APPLIED' &&
        (currentHeadReleaseId === undefined || currentHeadReleaseId === releaseId),
      reason:
        status !== 'APPLIED'
          ? 'Only an applied release can be reverted.'
          : currentHeadReleaseId !== undefined && currentHeadReleaseId !== releaseId
            ? 'A later release is the current venue deployment.'
            : null,
    },
    expectedUpdatedAt,
  }
}

export function releaseSummary(
  value: Record<string, unknown>,
  currentHeadReleaseId?: string | null,
) {
  const status = value.status as NativeStatus
  return {
    id: value.id,
    tenantId: value.tenantId,
    venueId: value.venueId,
    profile: value.profile,
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    allowedActions: actionGates(
      status,
      value.updatedAt as Date | string,
      value.id,
      currentHeadReleaseId,
    ),
  }
}

const lifecycleSnapshot = z
  .object({
    releaseId: z.string(),
    status: z.enum(['APPROVED', 'APPLIED', 'REVERTED']),
    updatedAt: z.string().datetime(),
    effectCount: z.number().int().nonnegative().optional(),
    head: z.object({ revision: z.number().int().positive() }).nullable().optional(),
  })
  .passthrough()

export function safeLifecycleResult(
  value: unknown,
  actionScope: { tenantId: string; venueId: string },
) {
  const parsed = lifecycleSnapshot.parse(value)
  return {
    releaseId: parsed.releaseId,
    tenantId: actionScope.tenantId,
    venueId: actionScope.venueId,
    profile: 'NATIVE_CORE_V1' as const,
    status: parsed.status,
    updatedAt: parsed.updatedAt,
    version: parsed.updatedAt,
    effectCount: parsed.effectCount ?? null,
    head: parsed.head
      ? { present: true as const, revision: parsed.head.revision }
      : { present: false as const, revision: null },
    allowedActions: actionGates(parsed.status, parsed.updatedAt),
  }
}

export function impactSummary(plan: unknown) {
  const effects = z
    .object({
      effects: z
        .array(
          z
            .object({
              kind: z.enum([
                'VENUE',
                'PLACE',
                'KNOWLEDGE',
                'GENERALIZED_MODULE',
                'GENERALIZED_PUBLICATION',
              ]),
            })
            .passthrough(),
        )
        .max(5_001),
    })
    .passthrough()
    .parse(plan).effects
  const byKind: Record<string, number> = {}
  for (const effect of effects) byKind[effect.kind] = (byKind[effect.kind] ?? 0) + 1
  return Object.entries(byKind)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ kind, count }))
}

export function mapError(error: unknown): never {
  if (error instanceof NativeVenueDeploymentError)
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'INVALID_INPUT'
            ? 'BAD_REQUEST'
            : error.code === 'CONFLICT'
              ? 'CONFLICT'
              : 'PRECONDITION_FAILED',
      message: error.message,
    })
  if (error instanceof z.ZodError)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Native deployment manifest validation failed.',
    })
  throw error
}
