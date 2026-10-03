import {
  LIVE_DATA_LIMITS,
  buildLiveDataResult,
  renderLiveDataPrompt,
  type LiveDataKind,
  type LiveDataResult,
} from '@pathfinder/contracts/live-data'

import type { TRPCContext } from '../context'
import { SOURCE_CONNECTION_PROVIDER } from '@pathfinder/contracts/source-connections'

/**
 * Guest-path read of venue live data. It reads ONLY the latest stored observation for ACTIVE
 * connectors of the resolved venue (exact tenant + venue predicates). It never calls a provider,
 * so guest traffic and token count cannot multiply provider calls; the worker owns every fetch.
 */

export type GuestLiveDataClient = Pick<TRPCContext['db'], 'liveDataConnector'>

const KIND: Record<'SPORTS_SCORE' | 'RIDE_STATUS' | 'GENERIC_JSON', LiveDataKind> = {
  SPORTS_SCORE: 'sports_score',
  RIDE_STATUS: 'ride_status',
  GENERIC_JSON: 'generic_json',
}

export const GUEST_LIVE_DATA_SELECT = {
  venueId: true,
  resourceId: true,
  resourceLabel: true,
  provider: true,
  kind: true,
  timezone: true,
  freshnessBudgetSeconds: true,
  lastErrorCategory: true,
  consecutiveFailures: true,
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

export async function loadGuestLiveDataContext(
  client: GuestLiveDataClient,
  input: { tenantId: string; venueId: string; now?: Date },
): Promise<{ prompt: string; results: LiveDataResult[] }> {
  const now = input.now ?? new Date()
  const rows = await client.liveDataConnector.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, state: 'ACTIVE' },
    select: GUEST_LIVE_DATA_SELECT,
    orderBy: { resourceLabel: 'asc' },
    take: LIVE_DATA_LIMITS.maxConnectorsPerVenue,
  })
  const results = rows
    .filter((row) => row.provider !== SOURCE_CONNECTION_PROVIDER)
    .map((row) =>
      buildLiveDataResult({
        connector: {
          venueId: row.venueId,
          resourceId: row.resourceId,
          resourceLabel: row.resourceLabel,
          provider: row.provider,
          kind: KIND[row.kind] ?? 'generic_json',
          timezone: row.timezone,
          freshnessBudgetSeconds: row.freshnessBudgetSeconds,
          lastErrorCategory: row.lastErrorCategory,
          consecutiveFailures: row.consecutiveFailures,
        },
        observation: row.observation,
        now,
      }),
    )
  return { prompt: renderLiveDataPrompt(results), results }
}
