import { SOURCE_CONNECTION_PROVIDER } from '@pathfinder/contracts/source-connections'

import { db } from '../client'

type Client = typeof db

const opaque = /^[A-Za-z0-9_-]{1,191}$/u
const CATEGORY = /^[a-z][a-z0-9_]{0,31}$/u

export type SourceConnectionDiagnosticInput = {
  tenantId: string
  venueId: string
  connectorId: string
  now: Date
  /** Short fixed category such as `invalid_config`; never a URL, body or message. */
  errorCategory: string
  /** Scheduled/manual runs: when to try again so a broken source does not hot-loop. */
  nextPollAt?: Date
  /** Preview runs also surface the category in the last-test fields. */
  preview?: boolean
}

/**
 * Records a connector-visible failure category when no valid config hash exists to
 * fence the richer helpers. Scoped by tenant, venue, connector and provider; it never
 * touches config, approval, state, snapshots or the stored preview.
 */
export async function recordSourceConnectionDiagnostic(
  input: SourceConnectionDiagnosticInput,
  client: Client = db,
): Promise<boolean> {
  if (
    !opaque.test(input.tenantId) ||
    !opaque.test(input.venueId) ||
    !opaque.test(input.connectorId) ||
    !CATEGORY.test(input.errorCategory)
  )
    return false
  const result = await client.liveDataConnector.updateMany({
    where: {
      id: input.connectorId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      provider: SOURCE_CONNECTION_PROVIDER,
    },
    data: {
      lastErrorAt: input.now,
      lastErrorCategory: input.errorCategory,
      consecutiveFailures: { increment: 1 },
      ...(input.nextPollAt && !input.preview ? { nextPollAt: input.nextPollAt } : {}),
      ...(input.preview
        ? {
            lastTestAt: input.now,
            lastTestOutcome: 'FAILED' as const,
            lastTestErrorCategory: input.errorCategory,
          }
        : {}),
    },
  })
  return result.count === 1
}
