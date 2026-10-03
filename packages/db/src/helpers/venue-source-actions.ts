import { db } from '../client'
import { writeAuditLogStrict } from './audit'

/**
 * Persistence for operator-requested venue sources. Every query carries tenant_id and venue_id
 * from the caller's verified scope. A source is evidence only: nothing here creates or changes
 * venue content, and recording a URL never fetches it.
 */
export type VenueSourceActionClient = Pick<typeof db, '$transaction'>
export type VenueSourceReadClient = Pick<
  typeof db,
  'venueSource' | 'venueSourceInput' | 'venueWebsiteOrigin'
>

export type VenueSourceActionErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_INPUT'
  | 'HOST_NOT_AUTHORIZED'

export class VenueSourceActionError extends Error {
  constructor(
    readonly code: VenueSourceActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VenueSourceActionError'
  }
}

/** A claim older than this is treated as abandoned (the worker died) and may be taken over. */
export const VENUE_SOURCE_CLAIM_STALE_MS = 2 * 60 * 1_000
/** A source is retried by the queue at most this many times before it is marked failed. */
export const VENUE_SOURCE_MAX_ATTEMPTS = 3

export const venueSourceSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  requestUrl: true,
  host: true,
  note: true,
  status: true,
  maxPages: true,
  maxBytesPerPage: true,
  parserVersion: true,
  operationId: true,
  requestedBy: true,
  attempts: true,
  errorCode: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
} as const

export type VenueSourceDisposition = 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'UNSUPPORTED' | 'SKIPPED'
export type VenueSourceTerminalStatus = 'SUCCEEDED' | 'PARTIAL' | 'FAILED'

export type VenueSourceInputRecord = {
  ordinal: number
  requestedUrl: string
  finalUrl: string | null
  redirectChain: Array<{ from: string; to: string; status: number }>
  disposition: VenueSourceDisposition
  reasonCode: string | null
  httpStatus: number | null
  contentType: string | null
  byteSize: number | null
  contentHash: string | null
  retrievedAt: Date
  parserVersion: string
  extractedText: string | null
  textTruncated: boolean
}

/**
 * Hosts a venue authorizes for source capture: the hosts of its active website origins. A venue
 * with no active origin authorizes nothing, so no outside request can start for it.
 */
export async function readAuthorizedSourceHostsAction(
  input: { tenantId: string; venueId: string },
  client: Pick<typeof db, 'venueWebsiteOrigin'> = db,
): Promise<string[]> {
  const rows = await client.venueWebsiteOrigin.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId, state: 'ACTIVE' },
    select: { origin: true },
    take: 100,
  })
  const hosts = new Set<string>()
  for (const row of rows) {
    try {
      const host = new URL(row.origin).hostname.toLowerCase().replace(/\.$/u, '')
      if (host) hosts.add(host)
    } catch {
      // An origin that no longer parses authorizes nothing.
    }
  }
  return [...hosts].sort()
}

export async function requestVenueSourceAction(
  input: {
    tenantId: string
    venueId: string
    operationId: string
    url: string
    host: string
    note?: string | undefined
    requestedBy: string
    requestedByRole: string
    maxPages: number
    maxBytesPerPage: number
    parserVersion: string
  },
  client: VenueSourceActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new VenueSourceActionError('NOT_FOUND', 'Venue not found')
    const existing = await tx.venueSource.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: venueSourceSelect,
    })
    if (existing) {
      if (existing.venueId !== input.venueId || existing.requestUrl !== input.url) {
        throw new VenueSourceActionError(
          'CONFLICT',
          'This operation was already used for a different source.',
        )
      }
      return { source: existing, replayed: true }
    }
    const authorized = await readAuthorizedSourceHostsAction(
      { tenantId: input.tenantId, venueId: input.venueId },
      tx,
    )
    if (!authorized.includes(input.host)) {
      throw new VenueSourceActionError(
        'HOST_NOT_AUTHORIZED',
        'The source host is not one of the venue’s authorized website origins.',
      )
    }
    const source = await tx.venueSource.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestUrl: input.url,
        host: input.host,
        ...(input.note !== undefined ? { note: input.note } : {}),
        maxPages: input.maxPages,
        maxBytesPerPage: input.maxBytesPerPage,
        parserVersion: input.parserVersion,
        operationId: input.operationId,
        requestedBy: input.requestedBy,
      },
      select: venueSourceSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.requestedBy,
        actorRole: input.requestedByRole,
        action: 'venue_source.requested',
        targetType: 'VenueSource',
        targetId: source.id,
        afterState: { venueId: input.venueId, host: input.host, status: source.status },
      },
      tx,
    )
    return { source, replayed: false }
  })
}

/**
 * Takes the capture for one source: only a REQUESTED source, or a FETCHING one whose claim went
 * stale, can be claimed, and the attempt counter moves with the claim. Returns null when another
 * worker holds it or it already finished, which makes a redelivered job a harmless no-op.
 */
export async function claimVenueSourceForCaptureAction(
  input: { tenantId: string; venueId: string; sourceId: string; now?: Date },
  client: Pick<typeof db, 'venueSource'> = db,
) {
  const now = input.now ?? new Date()
  const stale = new Date(now.getTime() - VENUE_SOURCE_CLAIM_STALE_MS)
  const claimed = await client.venueSource.updateMany({
    where: {
      id: input.sourceId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      OR: [{ status: 'REQUESTED' }, { status: 'FETCHING', startedAt: { lt: stale } }],
    },
    data: { status: 'FETCHING', startedAt: now, attempts: { increment: 1 } },
  })
  if (claimed.count !== 1) return null
  return client.venueSource.findFirst({
    where: { id: input.sourceId, tenantId: input.tenantId, venueId: input.venueId },
    select: venueSourceSelect,
  })
}

/** Gives a claim back after a retryable failure so the next delivery can take it. */
export async function releaseVenueSourceClaimAction(
  input: { tenantId: string; venueId: string; sourceId: string },
  client: Pick<typeof db, 'venueSource'> = db,
) {
  await client.venueSource.updateMany({
    where: {
      id: input.sourceId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      status: 'FETCHING',
    },
    data: { status: 'REQUESTED' },
  })
}

/** Writes the frozen inputs and the terminal status together. A finished source is never rewritten. */
export async function completeVenueSourceCaptureAction(
  input: {
    tenantId: string
    venueId: string
    sourceId: string
    status: VenueSourceTerminalStatus
    errorCode: string | null
    inputs: VenueSourceInputRecord[]
    now?: Date
  },
  client: VenueSourceActionClient = db,
) {
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const finished = await tx.venueSource.updateMany({
      where: {
        id: input.sourceId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'FETCHING',
      },
      data: { status: input.status, errorCode: input.errorCode, completedAt: now },
    })
    if (finished.count !== 1) return { written: false as const }
    if (input.inputs.length > 0) {
      await tx.venueSourceInput.createMany({
        data: input.inputs.map((record) => ({
          sourceId: input.sourceId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          ordinal: record.ordinal,
          requestedUrl: record.requestedUrl,
          finalUrl: record.finalUrl,
          redirectChain: record.redirectChain,
          disposition: record.disposition,
          reasonCode: record.reasonCode,
          httpStatus: record.httpStatus,
          contentType: record.contentType,
          byteSize: record.byteSize,
          contentHash: record.contentHash,
          retrievedAt: record.retrievedAt,
          parserVersion: record.parserVersion,
          extractedText: record.extractedText,
          textTruncated: record.textTruncated,
        })),
      })
    }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: 'system:venue-source-capture',
        actorRole: 'SYSTEM',
        actorType: 'SYSTEM',
        action: 'venue_source.captured',
        targetType: 'VenueSource',
        targetId: input.sourceId,
        afterState: {
          venueId: input.venueId,
          status: input.status,
          inputCount: input.inputs.length,
        },
      },
      tx,
    )
    return { written: true as const }
  })
}

/** Marks a source failed after the queue gave up on it. Only a source still being fetched changes. */
export async function failVenueSourceAction(
  input: { tenantId: string; venueId: string; sourceId: string; errorCode: string; now?: Date },
  client: Pick<typeof db, 'venueSource'> = db,
) {
  await client.venueSource.updateMany({
    where: {
      id: input.sourceId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      status: { in: ['REQUESTED', 'FETCHING'] },
    },
    data: { status: 'FAILED', errorCode: input.errorCode, completedAt: input.now ?? new Date() },
  })
}
