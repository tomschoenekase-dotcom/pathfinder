import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  readAuthorizedSourceHostsAction,
  requestVenueSourceAction,
  VenueSourceActionError,
} from '@pathfinder/db'
import { enqueueVenueSourceCapture } from '@pathfinder/jobs'

import { assertVenueInGrant } from '../grants'
import type { OperatorApplyContext, OperatorKindContext, OperatorProposalKind } from '../proposals'
import { VENUE_SOURCE_LIMITS, VENUE_SOURCE_PARSER_VERSION } from '../../lib/venue-source-capture'
import { assertPublicHttpsUrl } from './public-url'

const input = OPERATOR_MCP_INPUTS['venues.propose_source']
type SourceArgs = ReturnType<typeof input.parse>

/** A refusal at propose time the caller sees by name, with what to do about it. */
export class VenueSourceRefusal extends Error {
  constructor(
    readonly code: 'SOURCE_HOST_NOT_AUTHORIZED' | 'SOURCE_LIMIT' | 'SOURCE_ALREADY_PENDING',
    message: string,
  ) {
    super(message)
  }
}

/** At most this many captures for one venue may be waiting or running at once. */
const MAX_IN_FLIGHT_PER_VENUE = 5

function hostOf(url: URL) {
  return url.hostname.toLowerCase().replace(/\.$/u, '')
}

async function checkSource(args: SourceArgs, context: OperatorKindContext) {
  const url = assertPublicHttpsUrl(args.url)
  const host = hostOf(url)
  const authorized = await readAuthorizedSourceHostsAction(
    { tenantId: args.tenantId, venueId: args.venueId },
    context.database,
  )
  if (!authorized.includes(host)) {
    throw new VenueSourceRefusal(
      'SOURCE_HOST_NOT_AUTHORIZED',
      `${host} is not an authorized website origin for this venue. A person must add it under the venue's Visitor access website origins first; nothing was fetched.`,
    )
  }
  const inFlight = await context.database.venueSource.findMany({
    where: {
      tenantId: args.tenantId,
      venueId: args.venueId,
      status: { in: ['REQUESTED', 'FETCHING'] },
    },
    select: { requestUrl: true },
    take: MAX_IN_FLIGHT_PER_VENUE + 1,
  })
  if (inFlight.some((row) => row.requestUrl === args.url)) {
    throw new VenueSourceRefusal(
      'SOURCE_ALREADY_PENDING',
      'This URL is already waiting to be captured. Read it with venues.list_sources instead of requesting it again.',
    )
  }
  if (inFlight.length >= MAX_IN_FLIGHT_PER_VENUE) {
    throw new VenueSourceRefusal(
      'SOURCE_LIMIT',
      'This venue already has the most captures it may have in progress. Wait for one to finish.',
    )
  }
  return { host, authorized }
}

/**
 * Freezing a public web source as evidence. Approval records the request and queues one bounded,
 * SSRF-checked capture in a worker; recording a URL is not ingestion, and the captured text is
 * untrusted evidence that creates no content and changes nothing guests see.
 */
export const venuesSourceKind: OperatorProposalKind<SourceArgs> = {
  kind: 'venues.source',
  tool: 'venues.propose_source',
  capability: 'venues:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: async (args, context: OperatorKindContext) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    await checkSource(args, context)
  },
  // A new source has no earlier version to go stale; authorization is re-checked at apply.
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => {
    let host = 'unknown'
    try {
      host = hostOf(new URL(args.url))
    } catch {
      // The exact URL still shows below.
    }
    return {
      title: 'Capture a public web source as evidence',
      lines: [
        `URL: ${args.url}`,
        `Host: ${host}`,
        `Fetches at most ${VENUE_SOURCE_LIMITS.defaultMaxPages} pages of ${VENUE_SOURCE_LIMITS.defaultMaxBytesPerPage} bytes each, https only, only on hosts this venue authorizes, checking every redirect.`,
        'Stores a frozen snapshot (final URL, redirects, content hash, time, parser version). It adds no content and changes nothing guests see.',
        ...(args.note ? [`Note: ${args.note}`] : []),
      ],
    }
  },
  snapshot: async (args, context) => {
    const authorized = await readAuthorizedSourceHostsAction(
      { tenantId: args.tenantId, venueId: args.venueId },
      context.database,
    )
    return { venueId: args.venueId, url: args.url, authorizedHosts: authorized } as JsonValue
  },
  apply: async (args, context: OperatorApplyContext) => {
    const url = assertPublicHttpsUrl(args.url)
    let outcome: Awaited<ReturnType<typeof requestVenueSourceAction>>
    try {
      outcome = await requestVenueSourceAction(
        {
          tenantId: args.tenantId,
          venueId: args.venueId,
          operationId: context.operationId,
          url: args.url,
          host: hostOf(url),
          note: args.note,
          requestedBy: context.actor.id,
          requestedByRole: context.actor.role,
          maxPages: VENUE_SOURCE_LIMITS.defaultMaxPages,
          maxBytesPerPage: VENUE_SOURCE_LIMITS.defaultMaxBytesPerPage,
          parserVersion: VENUE_SOURCE_PARSER_VERSION,
        },
        context.database,
      )
    } catch (error) {
      if (error instanceof VenueSourceActionError && error.code === 'HOST_NOT_AUTHORIZED') {
        throw new VenueSourceRefusal('SOURCE_HOST_NOT_AUTHORIZED', error.message)
      }
      throw error
    }
    // The job ID is derived from the source, so a retried apply cannot queue a second capture.
    await enqueueVenueSourceCapture({
      tenantId: args.tenantId,
      venueId: args.venueId,
      sourceId: outcome.source.id,
    })
    return {
      result: {
        venueId: args.venueId,
        sourceId: outcome.source.id,
        status: outcome.source.status,
        captured: false,
      },
      after: {
        venueId: args.venueId,
        sourceId: outcome.source.id,
        status: outcome.source.status,
        host: outcome.source.host,
      },
    }
  },
  reconcile: async (args, context: OperatorApplyContext) => {
    const existing = await context.database.venueSource.findFirst({
      where: { tenantId: args.tenantId, venueId: args.venueId, operationId: context.operationId },
      select: { id: true, status: true, host: true },
    })
    if (!existing) return { state: 'not_applied' }
    // The row is the receipt. Queueing is idempotent, so make sure the capture was queued.
    await enqueueVenueSourceCapture({
      tenantId: args.tenantId,
      venueId: args.venueId,
      sourceId: existing.id,
    })
    return {
      state: 'applied',
      outcome: {
        result: {
          venueId: args.venueId,
          sourceId: existing.id,
          status: existing.status,
          captured: false,
        },
        after: {
          venueId: args.venueId,
          sourceId: existing.id,
          status: existing.status,
          host: existing.host,
        },
      },
    }
  },
}
