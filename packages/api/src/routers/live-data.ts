import { TRPCError } from '@trpc/server'

import {
  LIVE_DATA_LIMITS,
  buildLiveDataResult,
  checkLiveDataEndpoint,
  isLiveDataHostAllowed,
  parseLiveDataHostAllowlist,
  validateMappingForKind,
  type LiveDataKind,
  type LiveDataMapping,
} from '@pathfinder/contracts/live-data'
import { writeAuditLogStrict } from '@pathfinder/db'
import { enqueueLiveDataPoll } from '@pathfinder/jobs'

import { router } from '../core'
import { resolveGuestKnowledgePolicy } from '../lib/guest-knowledge-policy'
import { requireRole } from '../middleware/require-role'
import {
  CreateLiveDataConnectorInput,
  ListLiveDataConnectorsInput,
  LiveDataConnectorIdInput,
  LiveDataPolicyInput,
  UpdateLiveDataConnectorInput,
} from '../schemas/live-data'
import { tenantProcedure } from '../trpc'

export { CreateLiveDataConnectorInput, UpdateLiveDataConnectorInput } from '../schemas/live-data'

const KIND_TO_ENUM = {
  sports_score: 'SPORTS_SCORE',
  ride_status: 'RIDE_STATUS',
  generic_json: 'GENERIC_JSON',
} as const satisfies Record<LiveDataKind, string>
const ENUM_TO_KIND = {
  SPORTS_SCORE: 'sports_score',
  RIDE_STATUS: 'ride_status',
  GENERIC_JSON: 'generic_json',
} as const satisfies Record<string, LiveDataKind>

const connectorSelect = {
  id: true,
  venueId: true,
  name: true,
  kind: true,
  provider: true,
  resourceId: true,
  resourceLabel: true,
  endpointUrl: true,
  endpointHost: true,
  mapping: true,
  pollIntervalSeconds: true,
  freshnessBudgetSeconds: true,
  timezone: true,
  state: true,
  lastAttemptAt: true,
  lastSuccessAt: true,
  lastErrorCategory: true,
  lastErrorAt: true,
  consecutiveFailures: true,
  lastTestAt: true,
  lastTestOutcome: true,
  lastTestErrorCategory: true,
  lastTestPreview: true,
  updatedAt: true,
  observation: {
    select: {
      values: true,
      observedAt: true,
      fetchedAt: true,
      timestampBasis: true,
      conflicts: true,
    },
  },
} as const

type ConnectorRow = {
  id: string
  venueId: string
  name: string
  kind: keyof typeof ENUM_TO_KIND
  provider: string
  resourceId: string
  resourceLabel: string
  endpointUrl: string
  endpointHost: string
  mapping: unknown
  pollIntervalSeconds: number
  freshnessBudgetSeconds: number
  timezone: string
  state: 'ACTIVE' | 'DISABLED'
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  lastErrorCategory: string | null
  lastErrorAt: Date | null
  consecutiveFailures: number
  lastTestAt: Date | null
  lastTestOutcome: string | null
  lastTestErrorCategory: string | null
  lastTestPreview: unknown
  updatedAt: Date
  observation: {
    values: unknown
    observedAt: Date | null
    fetchedAt: Date
    timestampBasis: string
    conflicts: unknown
  } | null
}

/** Operator-facing projection. No secret exists to leak: connectors store no credentials. */
function toDto(row: ConnectorRow, now: Date) {
  const result = buildLiveDataResult({
    connector: {
      venueId: row.venueId,
      resourceId: row.resourceId,
      resourceLabel: row.resourceLabel,
      provider: row.provider,
      kind: ENUM_TO_KIND[row.kind],
      timezone: row.timezone,
      freshnessBudgetSeconds: row.freshnessBudgetSeconds,
      lastErrorCategory: row.lastErrorCategory,
      consecutiveFailures: row.consecutiveFailures,
    },
    observation: row.observation,
    now,
  })
  return {
    id: row.id,
    venueId: row.venueId,
    name: row.name,
    kind: ENUM_TO_KIND[row.kind],
    provider: row.provider,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    endpointUrl: row.endpointUrl,
    endpointHost: row.endpointHost,
    mapping: row.mapping,
    pollIntervalSeconds: row.pollIntervalSeconds,
    freshnessBudgetSeconds: row.freshnessBudgetSeconds,
    timezone: row.timezone,
    enabled: row.state === 'ACTIVE',
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorCategory: row.lastErrorCategory,
    lastErrorAt: row.lastErrorAt,
    consecutiveFailures: row.consecutiveFailures,
    lastTest: row.lastTestAt
      ? {
          at: row.lastTestAt,
          outcome: row.lastTestOutcome,
          errorCategory: row.lastTestErrorCategory,
          preview: row.lastTestPreview,
        }
      : null,
    liveState: result.state,
    liveValues: result.values,
    observedAt: result.observedAt,
    fetchedAt: result.fetchedAt,
    updatedAt: row.updatedAt,
  }
}

function assertEndpoint(rawUrl: string): { url: string; host: string } {
  const check = checkLiveDataEndpoint(rawUrl)
  if (!check.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: check.message })
  const allowed = isLiveDataHostAllowed(
    check.host,
    parseLiveDataHostAllowlist(process.env.LIVE_DATA_ALLOWED_HOSTS),
    { production: process.env.NODE_ENV === 'production' },
  )
  if (!allowed) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'This host is not on the platform live-data allowlist. Ask Torchiko to approve it.',
    })
  }
  return { url: check.url.toString(), host: check.host }
}

function assertMapping(kind: LiveDataKind, mapping: LiveDataMapping): void {
  const problems = validateMappingForKind(kind, mapping)
  if (problems.length > 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: problems.join('; ') })
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  )
}

function actor(ctx: { session: { userId: string; role: string } }) {
  return { actorId: ctx.session.userId, actorRole: ctx.session.role }
}

export const liveDataRouter = router({
  /** The three concepts the operator can inspect: general knowledge, open web, live connectors. */
  policy: tenantProcedure.input(LiveDataPolicyInput).query(async ({ ctx, input }) => {
    return resolveGuestKnowledgePolicy(ctx.db, {
      tenantId: ctx.session.activeTenantId,
      venueId: input.venueId,
    })
  }),

  list: tenantProcedure.input(ListLiveDataConnectorsInput).query(async ({ ctx, input }) => {
    const rows = await ctx.db.liveDataConnector.findMany({
      where: { tenantId: ctx.session.activeTenantId, venueId: input.venueId },
      select: connectorSelect,
      orderBy: { resourceLabel: 'asc' },
      take: LIVE_DATA_LIMITS.maxConnectorsPerVenue,
    })
    const now = new Date()
    return rows.map((row) => toDto(row as ConnectorRow, now))
  }),

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreateLiveDataConnectorInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      assertMapping(input.kind, input.mapping)
      const endpoint = assertEndpoint(input.endpointUrl)

      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })

      const [venueCount, tenantCount] = await Promise.all([
        ctx.db.liveDataConnector.count({ where: { tenantId, venueId: input.venueId } }),
        ctx.db.liveDataConnector.count({ where: { tenantId } }),
      ])
      if (
        venueCount >= LIVE_DATA_LIMITS.maxConnectorsPerVenue ||
        tenantCount >= LIVE_DATA_LIMITS.maxConnectorsPerTenant
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Live data connector limit reached.' })
      }

      try {
        return await ctx.db.$transaction(async (tx) => {
          // Created DISABLED: nothing is fetched until a manager has tested and enabled it.
          const created = await tx.liveDataConnector.create({
            data: {
              tenantId,
              venueId: input.venueId,
              name: input.name,
              kind: KIND_TO_ENUM[input.kind],
              provider: input.provider,
              resourceId: input.resourceId,
              resourceLabel: input.resourceLabel,
              endpointUrl: endpoint.url,
              endpointHost: endpoint.host,
              mapping: input.mapping,
              pollIntervalSeconds: input.pollIntervalSeconds,
              freshnessBudgetSeconds: input.freshnessBudgetSeconds,
              timezone: input.timezone,
              state: 'DISABLED',
              createdBy: ctx.session.userId,
              updatedBy: ctx.session.userId,
            },
            select: { id: true },
          })
          await writeAuditLogStrict(
            {
              tenantId,
              ...actor(ctx),
              action: 'live-data-connector.created',
              targetType: 'LiveDataConnector',
              targetId: created.id,
              afterState: {
                venueId: input.venueId,
                kind: input.kind,
                provider: input.provider,
                resourceId: input.resourceId,
                endpointHost: endpoint.host,
                pollIntervalSeconds: input.pollIntervalSeconds,
                freshnessBudgetSeconds: input.freshnessBudgetSeconds,
                enabled: false,
              },
            },
            tx,
          )
          return { id: created.id }
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A connector for this resource already exists at this venue.',
          })
        }
        throw error
      }
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateLiveDataConnectorInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const existing = await ctx.db.liveDataConnector.findFirst({
        where: { id: input.connectorId, tenantId },
        select: {
          id: true,
          venueId: true,
          kind: true,
          mapping: true,
          endpointUrl: true,
          pollIntervalSeconds: true,
          freshnessBudgetSeconds: true,
        },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connector not found.' })

      const kind = ENUM_TO_KIND[existing.kind]
      if (input.mapping) assertMapping(kind, input.mapping)
      const endpoint = input.endpointUrl ? assertEndpoint(input.endpointUrl) : null
      const pollIntervalSeconds = input.pollIntervalSeconds ?? existing.pollIntervalSeconds
      const freshnessBudgetSeconds = input.freshnessBudgetSeconds ?? existing.freshnessBudgetSeconds
      if (freshnessBudgetSeconds < pollIntervalSeconds) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The freshness budget must be at least the poll interval.',
        })
      }
      // Anything that changes what a stored value means invalidates it until the next poll.
      const invalidatesObservation =
        input.mapping !== undefined || (endpoint !== null && endpoint.url !== existing.endpointUrl)

      await ctx.db.$transaction(async (tx) => {
        await tx.liveDataConnector.updateMany({
          where: { id: existing.id, tenantId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.provider !== undefined ? { provider: input.provider } : {}),
            ...(input.resourceLabel !== undefined ? { resourceLabel: input.resourceLabel } : {}),
            ...(endpoint ? { endpointUrl: endpoint.url, endpointHost: endpoint.host } : {}),
            ...(input.mapping !== undefined ? { mapping: input.mapping } : {}),
            pollIntervalSeconds,
            freshnessBudgetSeconds,
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(invalidatesObservation
              ? { nextPollAt: null, consecutiveFailures: 0, lastErrorCategory: null }
              : {}),
            updatedBy: ctx.session.userId,
          },
        })
        if (invalidatesObservation) {
          await tx.liveDataObservation.deleteMany({
            where: { connectorId: existing.id, tenantId },
          })
        }
        await writeAuditLogStrict(
          {
            tenantId,
            ...actor(ctx),
            action: 'live-data-connector.updated',
            targetType: 'LiveDataConnector',
            targetId: existing.id,
            afterState: {
              venueId: existing.venueId,
              changed: Object.keys(input).filter((key) => key !== 'connectorId'),
              ...(endpoint ? { endpointHost: endpoint.host } : {}),
              observationCleared: invalidatesObservation,
            },
          },
          tx,
        )
      })
      return { id: existing.id }
    }),

  enable: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(LiveDataConnectorIdInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const existing = await ctx.db.liveDataConnector.findFirst({
        where: { id: input.connectorId, tenantId },
        select: { id: true, venueId: true, state: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connector not found.' })
      await ctx.db.$transaction(async (tx) => {
        await tx.liveDataConnector.updateMany({
          where: { id: existing.id, tenantId },
          data: {
            state: 'ACTIVE',
            nextPollAt: null,
            consecutiveFailures: 0,
            lastErrorCategory: null,
            updatedBy: ctx.session.userId,
          },
        })
        await writeAuditLogStrict(
          {
            tenantId,
            ...actor(ctx),
            action: 'live-data-connector.enabled',
            targetType: 'LiveDataConnector',
            targetId: existing.id,
            beforeState: { enabled: existing.state === 'ACTIVE' },
            afterState: { venueId: existing.venueId, enabled: true },
          },
          tx,
        )
      })
      return { id: existing.id, enabled: true }
    }),

  /** Disabling stops scheduled fetches and removes the connector from guest answers at once. */
  disable: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(LiveDataConnectorIdInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const existing = await ctx.db.liveDataConnector.findFirst({
        where: { id: input.connectorId, tenantId },
        select: { id: true, venueId: true, state: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connector not found.' })
      await ctx.db.$transaction(async (tx) => {
        await tx.liveDataConnector.updateMany({
          where: { id: existing.id, tenantId },
          data: { state: 'DISABLED', nextPollAt: null, updatedBy: ctx.session.userId },
        })
        await writeAuditLogStrict(
          {
            tenantId,
            ...actor(ctx),
            action: 'live-data-connector.disabled',
            targetType: 'LiveDataConnector',
            targetId: existing.id,
            beforeState: { enabled: existing.state === 'ACTIVE' },
            afterState: { venueId: existing.venueId, enabled: false },
          },
          tx,
        )
      })
      return { id: existing.id, enabled: false }
    }),

  /** Queues one worker-side test fetch; the result lands on the connector (never a guest answer). */
  test: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(LiveDataConnectorIdInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      const existing = await ctx.db.liveDataConnector.findFirst({
        where: { id: input.connectorId, tenantId },
        select: { id: true, venueId: true, lastTestAt: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Connector not found.' })
      const now = new Date()
      if (
        existing.lastTestAt &&
        now.getTime() - existing.lastTestAt.getTime() < LIVE_DATA_LIMITS.testCooldownSeconds * 1000
      ) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Wait ${LIVE_DATA_LIMITS.testCooldownSeconds} seconds between tests.`,
        })
      }
      await writeAuditLogStrict(
        {
          tenantId,
          ...actor(ctx),
          action: 'live-data-connector.test-requested',
          targetType: 'LiveDataConnector',
          targetId: existing.id,
          afterState: { venueId: existing.venueId },
        },
        ctx.db,
      )
      await enqueueLiveDataPoll(
        { tenantId, venueId: existing.venueId, connectorId: existing.id, mode: 'test' },
        now,
      )
      return { id: existing.id, queued: true }
    }),
})
