import { randomUUID } from 'node:crypto'
import {
  intelligenceMutation, intelligenceHash, intelligenceJson, scopedVenue, getChicagoVenue, queryChicagoVenueRows,
  ChicagoIntelligenceError, type ChicagoActor, type ChicagoScope, type ChicagoTransaction,
} from './chicago-intelligence-service'
import type { ChicagoVenueRow } from './chicago-intelligence-contract'
import {
  chicagoResearchPreviewInput, chicagoResearchQueueInput, chicagoResearchClaimInput,
  chicagoResearchCompleteInput, chicagoResearchReleaseInput,
  type ChicagoResearchCandidate, type ChicagoResearchGap, type ChicagoResearchPreview,
  type ChicagoResearchQueuedJob, type ChicagoResearchQueueResult, type ChicagoResearchClaimResult,
  type ChicagoResearchCompleteResult, type ChicagoResearchReleaseResult,
} from './chicago-intelligence-research-contract'

const SCHEMA = 'torchiko.chicago-research/v1'
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const conflict = (message: string): never => { throw new ChicagoIntelligenceError('CONFLICT', message) }
const uniqueGaps = (gaps: ChicagoResearchGap[]) => {
  const unique = new Map<string, ChicagoResearchGap>()
  for (const gap of gaps) if (!unique.has(gap.key)) unique.set(gap.key, gap)
  return [...unique.values()].slice(0, 10)
}

/** One candidate per geography/category cell before revisiting dense cells. No automatic queue. */
export async function previewChicagoResearch(raw: unknown, scope: ChicagoScope): Promise<ChicagoResearchPreview> {
  const input = chicagoResearchPreviewInput.parse(raw)
  const result = await queryChicagoVenueRows({ ...input.filters, lifecycle: 'active', page: 1, pageSize: 100,
    sorts: [{ field: 'researchPriority', direction: 'desc' }, { field: 'name', direction: 'asc' }] }, scope)
  const all = result.items.slice(0, 10000), total = result.total
  const cells = new Map<string, { rows: ChicagoVenueRow[]; eligible: ChicagoVenueRow[] }>()
  for (const row of all) {
    const key = JSON.stringify([row.city, row.state, row.category])
    const cell = cells.get(key) ?? { rows: [], eligible: [] }
    cell.rows.push(row)
    if (row.revision > 0 && row.ranking.researchGaps.length && !['excluded', 'intentionally-unranked'].includes(row.ranking.state)) cell.eligible.push(row)
    cells.set(key, cell)
  }
  const eligible = [...cells.values()].reduce((n, cell) => n + cell.eligible.length, 0)
  const groups = [...cells.values()].filter(cell => cell.eligible.length).sort((a, b) => {
    // Give sparsely represented cells an opportunity before selecting the same famous category repeatedly.
    const score = (cell: typeof a) => Math.max(...cell.eligible.map(row => row.ranking.researchPriority.value ?? 100))
    return score(b) - score(a) || a.rows.length - b.rows.length || a.eligible[0]!.venueId.localeCompare(b.eligible[0]!.venueId)
  })
  const candidates: ChicagoResearchCandidate[] = []
  for (let round = 0; candidates.length < input.limit && round < 10; round++) {
    let added = false
    for (const cell of groups) {
      const row = cell.eligible[round]
      if (!row) continue
      candidates.push({ venueId: row.venueId, organizationId: row.organizationId, name: row.name, city: row.city, state: row.state,
        category: row.category, expectedVersion: row.revision, stale: row.stale, gaps: uniqueGaps(row.ranking.researchGaps),
        priority: row.ranking.researchPriority.value ?? 100,
        coverageCell: { city: row.city, state: row.state, category: row.category, venues: cell.rows.length, needingResearch: cell.eligible.length } })
      added = true
      if (candidates.length === input.limit) break
    }
    if (!added) break
  }
  return { candidates, scanned: all.length, eligible, coverageCells: cells.size, truncated: all.length < total, queueCreated: false }
}

async function activeVenue(venueId: string, actor: ChicagoActor, tx: ChicagoTransaction) {
  const venue = await scopedVenue(venueId, actor.scope, tx)
  if (venue.archivedAt || venue.organization.archivedAt) throw new ChicagoIntelligenceError('CONFLICT', 'Archived locations or organizations cannot receive new research work')
  return venue
}
type QueuedJob = ChicagoResearchQueuedJob

async function latestRequest(tx: ChicagoTransaction, jobId: string): Promise<QueuedJob | null> {
  const receipts = await tx.prospectIntelligenceReceipt.findMany({ where: { operation: 'research-queue',
    result: { path: ['jobs'], array_contains: [{ jobId }] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1000 })
  const requests = receipts.flatMap(receipt => {
    const result = object(receipt.result)
    return Array.isArray(result.jobs) ? result.jobs.map(object).filter(job => job.jobId === jobId && Number.isInteger(job.generation) && typeof job.requestReceiptId === 'string') : []
  }) as unknown as QueuedJob[]
  // An explicit increasing generation avoids timestamp ties and preserves deduplicated queued requests.
  requests.sort((a, b) => b.generation - a.generation)
  return requests[0] ?? null
}

/** Explicit selection authorizes a bounded refresh. Jobs remain the native one-per-organization rows. */
export async function queueChicagoResearch(raw: unknown, actor: ChicagoActor) {
  const input = chicagoResearchQueueInput.parse(raw)
  // The bulk receipt has no single venueId: recheck ALL targets before even recovering a prior receipt.
  const details = new Map<string, Awaited<ReturnType<typeof getChicagoVenue>>>()
  for (const selection of input.selections) details.set(selection.venueId, await getChicagoVenue(selection.venueId, actor.scope))
  return intelligenceMutation('research-queue', input, actor, async (tx, receiptId) => {
    const jobs: QueuedJob[] = [], before: unknown[] = []
    const seenOrganizations = new Set<string>()
    for (const selection of input.selections) {
      const venue = await activeVenue(selection.venueId, actor, tx)
      const detail = details.get(venue.id)!
      if (venue.intelligence?.revision !== selection.expectedVersion || detail.revision !== selection.expectedVersion) conflict('Venue evidence changed; refresh research gaps before queuing')
      if (seenOrganizations.has(venue.organizationId)) throw new ChicagoIntelligenceError('INVALID_INPUT', 'Select one location per organization in a bounded batch; the native research job is organization-owned')
      seenOrganizations.add(venue.organizationId)
      const gaps = selection.gapKeys.map(key => detail.researchGaps.find(gap => gap.key === key))
      if (gaps.some(gap => !gap)) conflict('A selected gap is no longer present; refresh the venue before queuing')
      const exactGaps = gaps as ChicagoResearchGap[]
      const existing = await tx.prospectResearchJob.findUnique({ where: { organizationId: venue.organizationId } })
      const previousRequest = existing ? await latestRequest(tx, existing.id) : null
      const keepsGeneration = Boolean(existing && ['QUEUED', 'CLAIMED'].includes(existing.status) && previousRequest)
      if (keepsGeneration && (previousRequest!.venueId !== venue.id || intelligenceHash(previousRequest!.gaps) !== intelligenceHash(exactGaps))) conflict('This organization already has a different bounded research request; finish it with an honest complete or incomplete outcome before changing its scope')
      before.push({ venueId: venue.id, job: existing })
      let job = existing
      const priority = Math.min(100, Math.max(...exactGaps.map(gap => gap.priority)))
      if (!job) job = await tx.prospectResearchJob.create({ data: { id: `chrj_${intelligenceHash(venue.organizationId).slice(0, 32)}`, organizationId: venue.organizationId,
        status: 'QUEUED', priority, queuedBy: actor.id, terminalReason: null } })
      else if (!['QUEUED', 'CLAIMED'].includes(job.status)) {
        const updated = await tx.prospectResearchJob.updateMany({ where: { id: job.id, status: job.status, updatedAt: job.updatedAt }, data: {
          status: 'QUEUED', priority, queuedBy: actor.id, claimToken: null, claimOwnerId: null, claimAgentRunId: null, claimExpiresAt: null, terminalReason: null, completedAt: null,
        } })
        if (updated.count !== 1) conflict('Research job changed while requeueing; refresh its state')
        job = { ...job, status: 'QUEUED' }
      }
      jobs.push({ jobId: job.id, venueId: venue.id, organizationId: venue.organizationId, expectedVersion: selection.expectedVersion,
        gaps: exactGaps, status: job.status, deduplicated: Boolean(existing),
        generation: keepsGeneration ? previousRequest!.generation : (previousRequest?.generation ?? 0) + 1,
        requestReceiptId: keepsGeneration ? previousRequest!.requestReceiptId : receiptId })
    }
    return { venueId: null, before, after: { schema: SCHEMA, jobs }, result: { schema: SCHEMA, jobs, outreachAuthorized: false } }
  }) as Promise<ChicagoResearchQueueResult>
}

async function queueBinding(tx: ChicagoTransaction, queueReceiptId: string, jobId: string, venueId: string) {
  const receipt = await tx.prospectIntelligenceReceipt.findUnique({ where: { id: queueReceiptId } })
  const result = object(receipt?.result)
  const jobs = Array.isArray(result.jobs) ? result.jobs : []
  const binding = jobs.map(object).find(job => job.jobId === jobId && job.venueId === venueId)
  if (!receipt || receipt.operation !== 'research-queue' || result.schema !== SCHEMA || !binding) throw new ChicagoIntelligenceError('INVALID_INPUT', 'Claim requires the exact queued venue and durable Chicago research receipt')
  const latest = await latestRequest(tx, jobId)
  if (!latest || latest.generation !== binding.generation || latest.requestReceiptId !== binding.requestReceiptId) conflict('This queue receipt was superseded by a newer request generation; use the current research receipt')
  return binding as unknown as QueuedJob
}

export async function claimChicagoResearch(raw: unknown, actor: ChicagoActor) {
  const input = chicagoResearchClaimInput.parse(raw)
  await scopedVenue(input.venueId, actor.scope)
  return intelligenceMutation('research-claim', input, actor, async (tx, receiptId) => {
    const venue = await activeVenue(input.venueId, actor, tx)
    const binding = await queueBinding(tx, input.queueReceiptId, input.jobId, venue.id)
    if (binding.organizationId !== venue.organizationId) conflict('Venue organization changed after the research request')
    const job = await tx.prospectResearchJob.findUnique({ where: { id: input.jobId } })
    if (!job || job.organizationId !== venue.organizationId) throw new ChicagoIntelligenceError('NOT_FOUND', 'Research job is not owned by the selected Chicago venue organization')
    const now = new Date(), leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000), claimToken = randomUUID()
    const claimable = job.status === 'QUEUED' || (job.status === 'CLAIMED' && job.claimExpiresAt && job.claimExpiresAt <= now)
    if (!claimable) conflict('Research job is leased or terminal; inspect the current job before requesting more work')
    const claimed = await tx.prospectResearchJob.updateMany({ where: { id: job.id, organizationId: venue.organizationId,
      OR: [{ status: 'QUEUED' }, { status: 'CLAIMED', claimExpiresAt: { lte: now } }],
    }, data: { status: 'CLAIMED', claimToken, claimOwnerId: actor.id, claimAgentRunId: actor.runId, claimExpiresAt: leaseExpiresAt,
      attemptCount: { increment: 1 }, terminalReason: null, completedAt: null } })
    if (claimed.count !== 1) conflict('Another worker claimed this job; no lease acquired')
    if (job.claimToken) await tx.prospectResearchAttempt.updateMany({ where: { claimToken: job.claimToken, status: 'CLAIMED' },
      data: { status: 'EXPIRED', completedAt: now, outcomeReason: 'Lease expired; history retained before a new bounded claim' } })
    const attemptId = `chra_${receiptId}`
    await tx.prospectResearchAttempt.create({ data: { id: attemptId, jobId: job.id, claimToken, agentRunId: actor.runId, agentIdentityId: actor.id,
      promptIdentity: SCHEMA, leaseExpiresAt, usage: intelligenceJson({ chicagoResearch: { schema: SCHEMA, venueId: venue.id, queueReceiptId: input.queueReceiptId, gaps: binding.gaps } }) } })
    const result = { jobId: job.id, venueId: venue.id, claimToken, attemptId, leaseExpiresAt: leaseExpiresAt.toISOString(), gaps: binding.gaps, outreachAuthorized: false }
    return { venueId: venue.id, before: job, after: result, result }
  }) as Promise<ChicagoResearchClaimResult>
}

async function ownedLease(tx: ChicagoTransaction, input: { venueId: string; jobId: string; claimToken: string }, actor: ChicagoActor, allowExpired: boolean) {
  const venue = await activeVenue(input.venueId, actor, tx)
  const job = await tx.prospectResearchJob.findUnique({ where: { id: input.jobId } })
  const now = new Date()
  if (!job || job.organizationId !== venue.organizationId) throw new ChicagoIntelligenceError('NOT_FOUND', 'Research job is outside the selected venue organization')
  if (job.status !== 'CLAIMED' || job.claimToken !== input.claimToken || job.claimOwnerId !== actor.id || job.claimAgentRunId !== actor.runId ||
      !job.claimExpiresAt || (!allowExpired && job.claimExpiresAt <= now)) conflict('Research lease is expired, replaced or belongs to another actor/run')
  const attempt = await tx.prospectResearchAttempt.findUnique({ where: { claimToken: input.claimToken } })
  const binding = object(object(attempt?.usage).chicagoResearch)
  if (!attempt || attempt.status !== 'CLAIMED' || attempt.jobId !== job.id || attempt.agentIdentityId !== actor.id || attempt.agentRunId !== actor.runId || binding.schema !== SCHEMA || binding.venueId !== venue.id) conflict('Attempt is not bound to this exact Chicago research lease')
  return { venue, job, attempt: attempt!, binding, now }
}

export async function completeChicagoResearch(raw: unknown, actor: ChicagoActor) {
  const input = chicagoResearchCompleteInput.parse(raw)
  await scopedVenue(input.venueId, actor.scope)
  return intelligenceMutation('research-complete', input, actor, async (tx, receiptId) => {
    const { venue, job, attempt, binding, now } = await ownedLease(tx, input, actor, false)
    const gaps = Array.isArray(binding.gaps) ? binding.gaps.map(object) : []
    if (input.unknowns.some(unknown => !gaps.some(gap => gap.key === unknown.gapKey))) throw new ChicagoIntelligenceError('INVALID_INPUT', 'Unknown outcomes must identify a gap from the exact claimed request')
    const updated = await tx.prospectResearchJob.updateMany({ where: { id: job.id, status: 'CLAIMED', claimToken: input.claimToken,
      claimOwnerId: actor.id, claimAgentRunId: actor.runId, claimExpiresAt: { gt: now } },
      data: { status: input.outcome, claimToken: null, claimOwnerId: null, claimAgentRunId: null, claimExpiresAt: null, terminalReason: input.summary, completedAt: now } })
    if (updated.count !== 1) conflict('Lease changed or expired while completing; no completion evidence committed')
    const evidenceIds: string[] = []
    for (const [index, evidence] of input.evidence.entries()) {
      const id = `chre_${intelligenceHash([receiptId, index]).slice(0, 32)}`
      await tx.prospectSourceEvidence.create({ data: { id, organizationId: venue.organizationId, venueId: venue.id,
        sourceType: 'FIRST_PARTY_RESEARCH_OBSERVATION', sourceUrl: evidence.url, sourceLabel: evidence.statement,
        researchedAt: new Date(`${evidence.researchedAt}T00:00:00Z`), createdBy: actor.id,
        capturedValue: intelligenceJson({ schema: SCHEMA, jobId: job.id, attemptId: attempt.id, evidence, unknowns: input.unknowns,
          meaning: 'Research observation only; use the versioned evidence/field mutation to apply canonical facts or rankings' }) } })
      evidenceIds.push(id)
    }
    const completion = { outcome: input.outcome, summary: input.summary, evidence: input.evidence, evidenceIds, unknowns: input.unknowns, at: now.toISOString() }
    const finished = await tx.prospectResearchAttempt.updateMany({ where: { id: attempt.id, claimToken: input.claimToken, status: 'CLAIMED' },
      data: { status: 'COMPLETED', outcome: input.outcome, outcomeReason: input.summary, completedAt: now,
        usage: intelligenceJson({ ...object(attempt.usage), chicagoCompletion: completion }) } })
    if (finished.count !== 1) conflict('Attempt changed while completing; original history preserved')
    const result = { jobId: job.id, venueId: venue.id, attemptId: attempt.id, status: input.outcome, evidenceIds, unknowns: input.unknowns,
      canonicalFieldsApplied: false, outreachAuthorized: false }
    return { venueId: venue.id, before: { job, attempt }, after: completion, result }
  }) as Promise<ChicagoResearchCompleteResult>
}

export async function releaseChicagoResearch(raw: unknown, actor: ChicagoActor) {
  const input = chicagoResearchReleaseInput.parse(raw)
  await scopedVenue(input.venueId, actor.scope)
  return intelligenceMutation('research-release', input, actor, async tx => {
    const { venue, job, attempt, now } = await ownedLease(tx, input, actor, true)
    const expired = job.claimExpiresAt! <= now
    const released = await tx.prospectResearchJob.updateMany({ where: { id: job.id, status: 'CLAIMED', claimToken: input.claimToken, claimOwnerId: actor.id, claimAgentRunId: actor.runId },
      data: { status: 'QUEUED', claimToken: null, claimOwnerId: null, claimAgentRunId: null, claimExpiresAt: null, terminalReason: null, completedAt: null } })
    if (released.count !== 1) conflict('Lease replaced while releasing; no newer claim changed')
    const changed = await tx.prospectResearchAttempt.updateMany({ where: { id: attempt.id, status: 'CLAIMED', claimToken: input.claimToken },
      data: { status: expired ? 'EXPIRED' : 'RELEASED', completedAt: now, outcomeReason: input.reason } })
    if (changed.count !== 1) conflict('Attempt changed while releasing')
    const result = { jobId: job.id, venueId: venue.id, attemptId: attempt.id, status: 'QUEUED', expired, outreachAuthorized: false }
    return { venueId: venue.id, before: { job, attempt }, after: { ...result, reason: input.reason }, result }
  }) as Promise<ChicagoResearchReleaseResult>
}
