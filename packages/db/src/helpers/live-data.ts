import type { InputJsonValue } from '@prisma/client/runtime/library'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

/**
 * Worker-side persistence for venue live-data connectors. Every read and write below carries an
 * exact tenant + venue + connector scope; the single bypass only discovers opaque due IDs.
 */

export type LiveDataConnectorScope = {
  tenantId: string
  venueId: string
  connectorId: string
}

export type DueLiveDataConnector = {
  id: string
  tenantId: string
  venueId: string
  endpointHost: string
}

export async function listDueLiveDataConnectors(input: {
  now: Date
  limit: number
}): Promise<DueLiveDataConnector[]> {
  // Platform scheduler: cross-tenant discovery of opaque identities only. The poll job re-enters
  // the exact tenant + venue scope before anything is read, fetched or written.
  return withTenantIsolationBypass(() =>
    db.liveDataConnector.findMany({
      where: {
        state: 'ACTIVE',
        OR: [{ nextPollAt: null }, { nextPollAt: { lte: input.now } }],
      },
      select: { id: true, tenantId: true, venueId: true, endpointHost: true },
      orderBy: [{ nextPollAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: input.limit,
    }),
  )
}

const connectorPollSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  kind: true,
  provider: true,
  resourceId: true,
  endpointUrl: true,
  endpointHost: true,
  mapping: true,
  pollIntervalSeconds: true,
  freshnessBudgetSeconds: true,
  state: true,
  nextPollAt: true,
  consecutiveFailures: true,
} as const

export async function loadLiveDataConnectorForPoll(scope: LiveDataConnectorScope) {
  return db.liveDataConnector.findFirst({
    where: { id: scope.connectorId, tenantId: scope.tenantId, venueId: scope.venueId },
    select: connectorPollSelect,
  })
}

/**
 * Atomically reserves the next poll slot for an ACTIVE connector that is due. Returns false when
 * the connector was disabled, is not due yet, or another worker already claimed this slot, so a
 * duplicate or stale job never produces a second provider call.
 */
export async function claimLiveDataPoll(
  scope: LiveDataConnectorScope & { now: Date; nextPollAt: Date },
): Promise<boolean> {
  const result = await db.liveDataConnector.updateMany({
    where: {
      id: scope.connectorId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      state: 'ACTIVE',
      OR: [{ nextPollAt: null }, { nextPollAt: { lte: scope.now } }],
    },
    data: { nextPollAt: scope.nextPollAt, lastAttemptAt: scope.now },
  })
  return result.count === 1
}

export async function recordLiveDataPollSuccess(
  scope: LiveDataConnectorScope & {
    now: Date
    nextPollAt: Date
    observation: {
      values: InputJsonValue
      observedAt: Date | null
      timestampBasis: string
      conflicts: string[]
    }
  },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    // Fence on ACTIVE so a connector disabled during the fetch never gains a new observation.
    const updated = await tx.liveDataConnector.updateMany({
      where: {
        id: scope.connectorId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        state: 'ACTIVE',
      },
      data: {
        lastSuccessAt: scope.now,
        lastAttemptAt: scope.now,
        lastErrorCategory: null,
        lastErrorAt: null,
        consecutiveFailures: 0,
        nextPollAt: scope.nextPollAt,
      },
    })
    if (updated.count !== 1) return false
    const data = {
      values: scope.observation.values,
      observedAt: scope.observation.observedAt,
      fetchedAt: scope.now,
      timestampBasis: scope.observation.timestampBasis,
      conflicts: scope.observation.conflicts,
    }
    const existing = await tx.liveDataObservation.updateMany({
      where: { connectorId: scope.connectorId, tenantId: scope.tenantId },
      data,
    })
    if (existing.count === 0) {
      await tx.liveDataObservation.create({
        data: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          connectorId: scope.connectorId,
          ...data,
        },
      })
    }
    return true
  })
}

export async function recordLiveDataPollFailure(
  scope: LiveDataConnectorScope & { now: Date; nextPollAt: Date; errorCategory: string },
): Promise<void> {
  await db.liveDataConnector.updateMany({
    where: {
      id: scope.connectorId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      state: 'ACTIVE',
    },
    data: {
      lastAttemptAt: scope.now,
      lastErrorAt: scope.now,
      lastErrorCategory: scope.errorCategory,
      consecutiveFailures: { increment: 1 },
      nextPollAt: scope.nextPollAt,
    },
  })
}

/** Operator test results never write an observation and never change schedule or state. */
export async function recordLiveDataTestResult(
  scope: LiveDataConnectorScope & {
    now: Date
    outcome: 'OK' | 'FAILED'
    errorCategory: string | null
    preview: InputJsonValue | null
  },
): Promise<void> {
  await db.liveDataConnector.updateMany({
    where: { id: scope.connectorId, tenantId: scope.tenantId, venueId: scope.venueId },
    data: {
      lastTestAt: scope.now,
      lastTestOutcome: scope.outcome,
      lastTestErrorCategory: scope.errorCategory,
      ...(scope.preview !== null ? { lastTestPreview: scope.preview } : {}),
    },
  })
}
