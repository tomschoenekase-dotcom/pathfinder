import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'

import { processEmbedKnowledgeEntryJob } from '../processors/embed-knowledge-entry'
import { processEmbedPlaceJob } from '../processors/embed-place'
import { auditEmbeddingFreshness, type EmbeddingFreshnessCandidate } from './embedding-freshness'

/**
 * Refreshes the stale embeddings of one venue after a content import, with the same processors the
 * workers use. Plan mode (the default) only reads. Apply mode embeds at most --max records, two at
 * a time, never retries, stops at the first failure and appends a receipt line per record.
 */
export const VENUE_REFRESH_MAX = 1_000

/** Messages written by this command itself; safe to print, unlike database or provider errors. */
export class VenueRefreshError extends Error {}

export type VenueRefreshCommand =
  | { mode: 'plan'; tenantId: string; venueId: string }
  | { mode: 'apply'; tenantId: string; venueId: string; max: number; receipts: string }

export function parseVenueRefreshArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv,
): VenueRefreshCommand {
  const args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new VenueRefreshError(
        `Expected --name value arguments; invalid token ${key ?? '<missing>'}`,
      )
    }
    if (args.has(key)) throw new VenueRefreshError(`Duplicate argument ${key}`)
    args.set(key, value)
  }
  const allowed = new Set(['--tenant-id', '--venue-id', '--apply', '--max', '--receipts'])
  for (const key of args.keys())
    if (!allowed.has(key)) throw new VenueRefreshError(`Unknown argument ${key}`)
  const tenantId = args.get('--tenant-id')
  const venueId = args.get('--venue-id')
  if (!tenantId || !venueId) throw new VenueRefreshError('--tenant-id and --venue-id are required')
  // The background dispatcher must stay off, so this command is the only writer for the venue.
  if (environment.EMBEDDING_DISPATCH_ENABLED !== 'false') {
    throw new VenueRefreshError(
      'Requires EMBEDDING_DISPATCH_ENABLED=false in the target environment',
    )
  }
  if (!args.has('--apply')) {
    if (args.has('--max') || args.has('--receipts')) {
      throw new VenueRefreshError('--max and --receipts are only used with --apply yes')
    }
    return { mode: 'plan', tenantId, venueId }
  }
  if (args.get('--apply') !== 'yes') throw new VenueRefreshError('--apply must be yes')
  const max = Number(args.get('--max'))
  if (!Number.isInteger(max) || max < 1 || max > VENUE_REFRESH_MAX) {
    throw new VenueRefreshError(`--max must be an integer from 1 to ${VENUE_REFRESH_MAX}`)
  }
  const receipts = args.get('--receipts')
  if (!receipts)
    throw new VenueRefreshError('--receipts <new file path> is required with --apply yes')
  return { mode: 'apply', tenantId, venueId, max, receipts }
}

type Processors = {
  place: typeof processEmbedPlaceJob
  knowledge: typeof processEmbedKnowledgeEntryJob
}

const summary = (candidates: EmbeddingFreshnessCandidate[]) => ({
  places: candidates.filter((c) => c.entityType === 'PLACE').length,
  knowledgeEntries: candidates.filter((c) => c.entityType === 'KNOWLEDGE_ENTRY').length,
})

export async function runVenueRefreshCommand(
  command: VenueRefreshCommand,
  dependencies: {
    audit?: typeof auditEmbeddingFreshness
    processors?: Processors
    now?: () => Date
  } = {},
) {
  const audit = dependencies.audit ?? auditEmbeddingFreshness
  const processors = dependencies.processors ?? {
    place: processEmbedPlaceJob,
    knowledge: processEmbedKnowledgeEntryJob,
  }
  const before = await audit({ tenantId: command.tenantId, venueId: command.venueId })
  const stale = before.actionableCandidates.filter((c) => c.venueId === command.venueId)
  if (command.mode === 'plan') {
    return {
      mode: 'plan' as const,
      venueId: command.venueId,
      stale: summary(stale),
      truncated: before.truncated,
      next:
        stale.length === 0
          ? 'Every embedding for this venue is current.'
          : `Run again with --apply yes --max ${stale.length} --receipts <new file>.`,
    }
  }
  if (stale.length > command.max) {
    throw new VenueRefreshError(
      `${stale.length} records are stale; raise --max to at least that many`,
    )
  }
  writeFileSync(command.receipts, '', { flag: 'wx' })
  const record = (line: Record<string, unknown>) =>
    appendFileSync(command.receipts, `${JSON.stringify(line)}\n`)
  record({ action: 'refresh.started', venueId: command.venueId, count: stale.length })
  let refreshed = 0
  for (let index = 0; index < stale.length; index += 2) {
    const batch = stale.slice(index, index + 2)
    const settled = await Promise.allSettled(
      batch.map((candidate) => {
        const execution = {
          bullJobId: `venue-refresh-${randomUUID()}`,
          attemptNumber: 1,
          maxAttempts: 1,
        }
        const contentUpdatedAt = candidate.contentUpdatedAt.toISOString()
        return candidate.entityType === 'PLACE'
          ? processors.place(
              { tenantId: candidate.tenantId, placeId: candidate.entityId, contentUpdatedAt },
              execution,
            )
          : processors.knowledge(
              { tenantId: candidate.tenantId, entryId: candidate.entityId, contentUpdatedAt },
              execution,
            )
      }),
    )
    settled.forEach((outcome, offset) => {
      const candidate = batch[offset]!
      record({
        action: 'refresh.entity',
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        reason: candidate.primaryReason,
        ok: outcome.status === 'fulfilled',
      })
    })
    if (settled.some((outcome) => outcome.status === 'rejected')) {
      record({ action: 'refresh.stopped', refreshed })
      throw new VenueRefreshError(
        'An embedding failed; stopped without retrying. See the receipts.',
      )
    }
    refreshed += batch.length
  }
  const after = await audit({ tenantId: command.tenantId, venueId: command.venueId })
  const remaining = after.actionableCandidates.filter((c) => c.venueId === command.venueId)
  record({ action: 'refresh.complete', refreshed, remaining: remaining.length })
  return {
    mode: 'apply' as const,
    venueId: command.venueId,
    refreshed,
    remaining: summary(remaining),
  }
}
