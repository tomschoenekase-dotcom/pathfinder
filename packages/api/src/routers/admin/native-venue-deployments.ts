import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  applyNativeVenueDeploymentAction,
  approveNativeVenueDeploymentAction,
  createNativeVenueDeploymentAction,
  db,
  NativeVenueDeploymentError,
  projectNativeVenueStateAction,
  revertNativeVenueDeploymentAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scope = z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }).strict()
const lifecycle = scope
  .extend({
    releaseId: z.string().uuid(),
    commandId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict()
const lifecycleSnapshot = z
  .object({
    releaseId: z.string(),
    status: z.enum(['APPROVED', 'APPLIED', 'REVERTED']),
    updatedAt: z.string().datetime(),
    effectCount: z.number().int().nonnegative().optional(),
    head: z.object({ revision: z.number().int().positive() }).nullable().optional(),
  })
  .passthrough()
type NativeStatus = 'DRAFT' | 'APPROVED' | 'APPLIED' | 'REVERTED'
const coverage = [
  { section: 'VENUE_CONFIGURATION', disposition: 'SUPPORTED' },
  { section: 'PLACES', disposition: 'SUPPORTED' },
  { section: 'KNOWLEDGE', disposition: 'SUPPORTED' },
  { section: 'GENERALIZED_MODULES', disposition: 'SUPPORTED' },
  { section: 'ITEMS', disposition: 'SUPPORTED_EMPTY_ONLY' },
  { section: 'ASSETS', disposition: 'SUPPORTED_EMPTY_ONLY' },
  { section: 'CAPABILITY_MODEL_REFERENCES', disposition: 'SUPPORTED_EMPTY_ONLY' },
] as const
function actor(userId: string) {
  return { type: 'HUMAN' as const, role: 'PLATFORM_ADMIN' as const, id: userId }
}
function actionGates(
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
function releaseSummary(value: Record<string, unknown>, currentHeadReleaseId?: string | null) {
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
function safeLifecycleResult(value: unknown, actionScope: z.infer<typeof lifecycle>) {
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
function impactSummary(plan: unknown) {
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
function mapError(error: unknown): never {
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

export const adminNativeVenueDeploymentsRouter = router({
  listNativeVenueDeployments: adminProcedure
    .input(
      scope
        .extend({
          cursor: z.string().uuid().nullable().default(null),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [rows, head] = await Promise.all([
          db.nativeVenueDeploymentRelease.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
            take: input.limit + 1,
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              profile: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          db.nativeVenueDeploymentHead.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            select: { releaseId: true },
          }),
        ])
        return {
          items: rows
            .slice(0, input.limit)
            .map((row) => releaseSummary(row, head?.releaseId ?? null)),
          nextCursor: rows.length > input.limit ? (rows[input.limit - 1]?.id ?? null) : null,
        }
      }),
    ),
  getNativeVenueDeployment: adminProcedure
    .input(
      scope
        .extend({
          releaseId: z.string().uuid(),
          issueCursor: z.number().int().nonnegative().default(0),
          issueLimit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [row, head] = await Promise.all([
          db.nativeVenueDeploymentRelease.findFirst({
            where: { id: input.releaseId, tenantId: input.tenantId, venueId: input.venueId },
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              profile: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              approvedAt: true,
              appliedAt: true,
              revertedAt: true,
              expectedEffectCount: true,
              plan: true,
              _count: { select: { effects: true, commands: true } },
            },
          }),
          db.nativeVenueDeploymentHead.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            select: { releaseId: true },
          }),
        ])
        if (!row)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Native deployment was not found.' })
        const impacts = impactSummary(row.plan)
        const status = row.status as NativeStatus
        return {
          id: row.id,
          tenantId: row.tenantId,
          venueId: row.venueId,
          profile: row.profile,
          status,
          version: row.updatedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          approvedAt: row.approvedAt,
          appliedAt: row.appliedAt,
          revertedAt: row.revertedAt,
          coverage,
          materializable: true,
          unsupported: false,
          issues: [],
          issueCount: 0,
          nextIssueCursor: null,
          impactSummary: impacts,
          effectSummary: {
            expected: row.expectedEffectCount,
            recorded: row._count.effects,
            byKind: impacts,
          },
          commandCount: row._count.commands,
          allowedActions: actionGates(status, row.updatedAt, row.id, head?.releaseId ?? null),
        }
      }),
    ),
  projectNativeVenueDeployment: adminProcedure.input(scope).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      try {
        return await projectNativeVenueStateAction(db, input)
      } catch (error) {
        mapError(error)
      }
    }),
  ),
  createNativeVenueDeployment: adminProcedure
    .input(scope.extend({ manifestJson: z.string().min(2).max(2_000_000) }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          let manifest: unknown
          try {
            manifest = JSON.parse(input.manifestJson) as unknown
          } catch {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Manifest text is not valid JSON.',
            })
          }
          const release = await createNativeVenueDeploymentAction(
            {
              ...input,
              manifest,
              actor: actor(ctx.session.userId),
            },
            db,
          )
          return releaseSummary(release)
        } catch (error) {
          mapError(error)
        }
      }),
    ),
  approveNativeVenueDeployment: adminProcedure.input(lifecycle).mutation(({ ctx, input }) =>
    withTenantIsolationBypass(async () => {
      try {
        return safeLifecycleResult(
          await approveNativeVenueDeploymentAction(
            { ...input, actor: actor(ctx.session.userId) },
            db,
          ),
          input,
        )
      } catch (error) {
        mapError(error)
      }
    }),
  ),
  applyNativeVenueDeployment: adminProcedure.input(lifecycle).mutation(({ ctx, input }) =>
    withTenantIsolationBypass(async () => {
      try {
        return safeLifecycleResult(
          await applyNativeVenueDeploymentAction(
            { ...input, actor: actor(ctx.session.userId) },
            db,
          ),
          input,
        )
      } catch (error) {
        mapError(error)
      }
    }),
  ),
  revertNativeVenueDeployment: adminProcedure.input(lifecycle).mutation(({ ctx, input }) =>
    withTenantIsolationBypass(async () => {
      try {
        return safeLifecycleResult(
          await revertNativeVenueDeploymentAction(
            { ...input, actor: actor(ctx.session.userId) },
            db,
          ),
          input,
        )
      } catch (error) {
        mapError(error)
      }
    }),
  ),
})
