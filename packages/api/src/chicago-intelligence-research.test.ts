import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { ChicagoActor } from './chicago-intelligence-service'

const fake = vi.hoisted(() => ({ venues: new Map<string, any>(), jobs: new Map<string, any>(), attempts: new Map<string, any>(),
  receipts: new Map<string, any>(), evidence: new Map<string, any>(), directory: [] as any[], failJobCas: false }))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part))
    if (value && !(value instanceof Date) && typeof value === 'object') {
      if ('lte' in value) return row[key] !== null && row[key] <= value.lte
      if ('gt' in value) return row[key] !== null && row[key] > value.gt
    }
    return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value
  })
}
function table(map: Map<string, any>, kind: string) {
  return {
    async findUnique({ where }: any) { return [...map.values()].find(row => matches(row, where)) ?? null },
    async create({ data }: any) {
      if (map.has(data.id)) throw new Error('duplicate fixture record')
      const row = { claimToken: null, claimOwnerId: null, claimAgentRunId: null, claimExpiresAt: null, attemptCount: 0, completedAt: null,
        updatedAt: new Date(), createdAt: new Date(), status: kind === 'job' ? 'QUEUED' : 'CLAIMED', ...data }
      map.set(row.id, row); return structuredClone(row)
    },
    async updateMany({ where, data }: any) {
      if (kind === 'job' && fake.failJobCas) { fake.failJobCas = false; return { count: 0 } }
      let count = 0
      for (const [id, row] of map) if (matches(row, where)) {
        const patch = Object.fromEntries(Object.entries(data).map(([key, value]: [string, any]) => [key, value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value]))
        map.set(id, { ...row, ...patch, updatedAt: new Date() }); count++
      }
      return { count }
    },
  }
}
vi.mock('./chicago-intelligence-service', () => {
  class ErrorWithCode extends Error { constructor(readonly code: string, message: string) { super(message) } }
  const scoped = async (venueId: string, scope: any) => {
    const row = fake.venues.get(venueId)
    if (!row || row.territoryId !== 'chi' || scope.mode === 'TERRITORIES' && !scope.territoryIds.includes('chi')) throw new ErrorWithCode('NOT_FOUND', 'out of scope')
    return structuredClone(row)
  }
  return {
    ChicagoIntelligenceError: ErrorWithCode,
    intelligenceHash: (value: unknown) => hash(value), intelligenceJson: (value: unknown) => JSON.parse(JSON.stringify(value)),
    scopedVenue: scoped,
    getChicagoVenue: async (venueId: string, scope: any) => {
      const row = await scoped(venueId, scope)
      return { venueId, revision: row.intelligence.revision, researchGaps: [{ key: 'firstPartySources', reason: 'Verify first-party source ownership.', priority: 90 }, { key: 'knowledgeRichness', reason: 'Knowledge richness remains unknown.', priority: 100 }] }
    },
    queryChicagoVenueRows: async () => ({ items: fake.directory, total: fake.directory.length }),
    intelligenceMutation: async (operation: string, input: any, actor: any, apply: any) => {
      if (!actor.id || !actor.runId || !actor.capabilities.includes('prospects.maintain')) throw new ErrorWithCode('FORBIDDEN', 'missing grant')
      const id = hash([actor.id, actor.runId, input.idempotencyKey]), inputHash = hash({ operation, input })
      const prior = fake.receipts.get(id)
      if (prior) {
        if (prior.inputHash !== inputHash) throw new ErrorWithCode('CONFLICT', 'substituted retry')
        return { receiptId: id, replayed: true, ...prior.result }
      }
      const maps = [fake.jobs, fake.attempts, fake.evidence]
      const snapshots = maps.map(map => structuredClone(map))
      try {
        const tx = { prospectResearchJob: table(fake.jobs, 'job'), prospectResearchAttempt: table(fake.attempts, 'attempt'),
          prospectSourceEvidence: table(fake.evidence, 'evidence'), prospectIntelligenceReceipt: {
            findUnique: async ({ where }: any) => fake.receipts.get(where.id) ?? null,
            findMany: async ({ where }: any) => [...fake.receipts.values()].filter(receipt => receipt.operation === where.operation && receipt.result.jobs.some((job: any) => job.jobId === where.result.array_contains[0].jobId)),
          } }
        const change = await apply(tx, id)
        fake.receipts.set(id, { id, operation, inputHash, ...change })
        return { receiptId: id, replayed: false, ...change.result }
      } catch (error) {
        maps.forEach((map, i) => { map.clear(); snapshots[i]!.forEach((row, key) => map.set(key, row)) }); throw error
      }
    },
  }
})
import { previewChicagoResearch, queueChicagoResearch, claimChicagoResearch, completeChicagoResearch, releaseChicagoResearch } from './chicago-intelligence-research'
import { chicagoResearchCompleteInput, chicagoResearchQueueInput, chicagoResearchClaimInput } from './chicago-intelligence-research-contract'

const actor: ChicagoActor = { id: 'agent-1', type: 'AGENT', runId: 'run-1', scope: { mode: 'TERRITORIES', territoryIds: ['chi'] }, capabilities: ['prospects.maintain'] }
const selection = { venueId: 'v1', expectedVersion: 1, gapKeys: ['firstPartySources'] }
const evidence = { url: 'https://museum.example.org/visit', researchedAt: '2026-09-22', statement: 'The official museum visitor page describes its public collection.', firstParty: true }
async function lease() {
  const queue = await queueChicagoResearch({ idempotencyKey: 'queue-1', selections: [selection] }, actor)
  const claimed = await claimChicagoResearch({ idempotencyKey: 'claim-1', venueId: 'v1', jobId: queue.jobs[0]!.jobId, queueReceiptId: queue.receiptId, leaseSeconds: 60 }, actor)
  return { queue, claimed }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T12:00:00Z'))
  for (const map of [fake.venues, fake.jobs, fake.attempts, fake.receipts, fake.evidence]) map.clear()
  fake.directory = []; fake.failJobCas = false
  for (const id of ['v1', 'v2']) fake.venues.set(id, { id, organizationId: `org-${id}`, territoryId: 'chi', archivedAt: null, organization: { archivedAt: null }, intelligence: { revision: 1 } })
})
afterEach(() => vi.useRealTimers())

describe('Chicago bounded research lifecycle', () => {
  it('limits queue/lease and refuses invented authority, invalid dates and unsupported completion', () => {
    expect(chicagoResearchQueueInput.safeParse({ idempotencyKey: 'q', selections: Array.from({ length: 11 }, (_, i) => ({ ...selection, venueId: `v${i}` })) }).success).toBe(false)
    expect(chicagoResearchQueueInput.safeParse({ idempotencyKey: 'q', selections: [selection], actor: 'operator' }).success).toBe(false)
    expect(chicagoResearchClaimInput.safeParse({ idempotencyKey: 'q', venueId: 'v1', jobId: 'j', queueReceiptId: 'r', leaseSeconds: 1801 }).success).toBe(false)
    const completion = { idempotencyKey: 'done', venueId: 'v1', jobId: 'j', claimToken: '9ab096ed-79cb-4cce-a754-fd123091c9a4', outcome: 'RESEARCHED', summary: 'Completed the bounded source review.', evidence: [evidence], unknowns: [] }
    expect(chicagoResearchCompleteInput.safeParse(completion).success).toBe(true)
    expect(chicagoResearchCompleteInput.safeParse({ ...completion, evidence: [{ ...evidence, researchedAt: '2026-02-30' }] }).success).toBe(false)
    expect(chicagoResearchCompleteInput.safeParse({ ...completion, evidence: [] }).success).toBe(false)
    expect(chicagoResearchCompleteInput.safeParse({ ...completion, unknowns: [{ gapKey: 'firstPartySources', reason: 'Source ownership could not be proved.' }] }).success).toBe(false)
    expect(chicagoResearchCompleteInput.safeParse({ ...completion, outcome: 'BLOCKED' }).success).toBe(false)
  })
  it('preview stratifies across coverage cells and never queues work', async () => {
    fake.directory = ['v1', 'v2', 'v3'].map((venueId, i) => ({ venueId, organizationId: `o${i}`, name: venueId, city: i === 2 ? 'Evanston' : 'Chicago', state: 'IL', category: 'museum', revision: 1, stale: true,
      ranking: { state: 'needs-research', researchPriority: { value: 100 }, researchGaps: [{ key: 'firstPartySources', reason: 'Missing first-party source.', priority: 90 }] } }))
    const result = await previewChicagoResearch({ limit: 2 }, actor.scope)
    expect(new Set(result.candidates.map(candidate => candidate.city)).size).toBe(2)
    expect(result).toMatchObject({ scanned: 3, coverageCells: 2, eligible: 3, queueCreated: false, truncated: false })
    expect(fake.jobs.size).toBe(0)
  })
  it('stores exact derived gaps and deduplicates native organization jobs across request keys', async () => {
    const input = { idempotencyKey: 'queue', selections: [selection] }
    const first = await queueChicagoResearch(input, actor)
    const retry = await queueChicagoResearch(input, actor)
    const other = await queueChicagoResearch({ ...input, idempotencyKey: 'queue-2' }, actor)
    expect(fake.jobs.size).toBe(1)
    expect(retry).toMatchObject({ receiptId: first.receiptId, replayed: true })
    expect(other.jobs[0]).toMatchObject({ jobId: first.jobs[0]!.jobId, deduplicated: true, gaps: [{ key: 'firstPartySources', reason: 'Verify first-party source ownership.', priority: 90 }] })
  })
  it('rechecks every bulk venue scope on receipt replay and rejects stale gap snapshots atomically', async () => {
    const input = { idempotencyKey: 'queue', selections: [selection] }
    await queueChicagoResearch(input, actor)
    await expect(queueChicagoResearch(input, { ...actor, scope: { mode: 'TERRITORIES', territoryIds: [] } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(queueChicagoResearch({ idempotencyKey: 'stale', selections: [{ ...selection, venueId: 'v2' }, { ...selection, expectedVersion: 2 }] }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.jobs.size).toBe(1)
    await expect(queueChicagoResearch({ idempotencyKey: 'invented', selections: [{ ...selection, gapKeys: ['privateEmail'] }] }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('requires maintain capability and exact queue receipt/venue binding', async () => {
    await expect(queueChicagoResearch({ idempotencyKey: 'x', selections: [selection] }, { ...actor, capabilities: ['prospects.read'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const queued = await queueChicagoResearch({ idempotencyKey: 'q', selections: [selection] }, actor)
    await expect(claimChicagoResearch({ idempotencyKey: 'c', venueId: 'v2', jobId: queued.jobs[0]!.jobId, queueReceiptId: queued.receiptId }, actor)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fake.attempts.size).toBe(0)
  })
  it('claims through CAS and recovers the exact token after a lost claim response', async () => {
    const { queue, claimed } = await lease()
    const retry = await claimChicagoResearch({ idempotencyKey: 'claim-1', venueId: 'v1', jobId: claimed.jobId, queueReceiptId: queue.receiptId, leaseSeconds: 60 }, actor)
    expect(retry).toMatchObject({ claimToken: claimed.claimToken, receiptId: claimed.receiptId, replayed: true })
    expect(fake.attempts.size).toBe(1)
    await expect(claimChicagoResearch({ idempotencyKey: 'claim-2', venueId: 'v1', jobId: claimed.jobId, queueReceiptId: queue.receiptId }, { ...actor, id: 'other' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('a failed CAS leaves no attempt or claim receipt', async () => {
    const queue = await queueChicagoResearch({ idempotencyKey: 'q', selections: [selection] }, actor)
    fake.failJobCas = true
    await expect(claimChicagoResearch({ idempotencyKey: 'c', venueId: 'v1', jobId: queue.jobs[0]!.jobId, queueReceiptId: queue.receiptId }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.attempts.size).toBe(0)
    expect(fake.receipts.size).toBe(1)
  })
  it('expiry reclaim retains expired attempt and rejects the stale former owner', async () => {
    const { queue, claimed } = await lease()
    vi.setSystemTime(new Date('2026-09-22T12:01:01Z'))
    const next = await claimChicagoResearch({ idempotencyKey: 'reclaim', venueId: 'v1', jobId: claimed.jobId, queueReceiptId: queue.receiptId }, { ...actor, id: 'agent-2', runId: 'run-2' })
    expect(next.claimToken).not.toBe(claimed.claimToken)
    expect(fake.attempts.get(claimed.attemptId).status).toBe('EXPIRED')
    await expect(completeChicagoResearch({ idempotencyKey: 'late', venueId: 'v1', jobId: claimed.jobId, claimToken: claimed.claimToken,
      outcome: 'RESEARCHED', summary: 'Completed source-backed research.', evidence: [evidence], unknowns: [] }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.evidence.size).toBe(0)
  })
  it('exact completion replay preserves evidence and unknowns without needing the consumed lease', async () => {
    const { claimed } = await lease()
    const input = { idempotencyKey: 'complete', venueId: 'v1', jobId: claimed.jobId, claimToken: claimed.claimToken,
      outcome: 'NEEDS_REVIEW', summary: 'Public page found; operator ownership remains unresolved.', evidence: [evidence],
      unknowns: [{ gapKey: 'firstPartySources', reason: 'The page does not establish the exact venue operator.' }] }
    const done = await completeChicagoResearch(input, actor)
    const retry = await completeChicagoResearch(input, actor)
    expect(done).toMatchObject({ status: 'NEEDS_REVIEW', canonicalFieldsApplied: false, outreachAuthorized: false })
    expect(retry).toMatchObject({ receiptId: done.receiptId, evidenceIds: done.evidenceIds, unknowns: input.unknowns, replayed: true })
    expect(fake.evidence.size).toBe(1)
    expect(fake.jobs.get(claimed.jobId).claimToken).toBe(null)
    expect(fake.attempts.get(claimed.attemptId).usage.chicagoCompletion.unknowns).toEqual(input.unknowns)
    await expect(completeChicagoResearch({ ...input, summary: 'Changed result under an old completion key.' }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('expired completion and wrong run cannot commit evidence; own release is replayable', async () => {
    const { claimed } = await lease()
    const input = { idempotencyKey: 'complete', venueId: 'v1', jobId: claimed.jobId, claimToken: claimed.claimToken,
      outcome: 'RESEARCHED', summary: 'Completed source-backed research.', evidence: [evidence], unknowns: [] }
    await expect(completeChicagoResearch(input, { ...actor, runId: 'other-run' })).rejects.toMatchObject({ code: 'CONFLICT' })
    vi.setSystemTime(new Date('2026-09-22T12:01:01Z'))
    await expect(completeChicagoResearch(input, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    const release = { idempotencyKey: 'release', venueId: 'v1', jobId: claimed.jobId, claimToken: claimed.claimToken, reason: 'Source unavailable; release the unfinished bounded request.' }
    const first = await releaseChicagoResearch(release, actor)
    expect(first).toMatchObject({ status: 'QUEUED', expired: true })
    expect(await releaseChicagoResearch(release, actor)).toMatchObject({ receiptId: first.receiptId, replayed: true })
    expect(fake.evidence.size).toBe(0)
    expect(fake.attempts.get(claimed.attemptId).status).toBe('EXPIRED')
  })
  it('terminal requeue advances generation and rejects obsolete request receipts despite equal timestamps', async () => {
    const { queue, claimed } = await lease()
    await completeChicagoResearch({ idempotencyKey: 'done', venueId: 'v1', jobId: claimed.jobId, claimToken: claimed.claimToken,
      outcome: 'NEEDS_REVIEW', summary: 'Source ownership remains unknown after the bounded attempt.', evidence: [],
      unknowns: [{ gapKey: 'firstPartySources', reason: 'No current first-party ownership source was found.' }] }, actor)
    const nextQueue = await queueChicagoResearch({ idempotencyKey: 'requeue', selections: [selection] }, actor)
    expect(nextQueue.jobs[0]!.generation).toBe(2)
    await expect(claimChicagoResearch({ idempotencyKey: 'obsolete-claim', venueId: 'v1', jobId: claimed.jobId, queueReceiptId: queue.receiptId }, actor)).rejects.toMatchObject({ code: 'CONFLICT' })
    const nextClaim = await claimChicagoResearch({ idempotencyKey: 'new-claim', venueId: 'v1', jobId: claimed.jobId, queueReceiptId: nextQueue.receiptId }, actor)
    expect(nextClaim.claimToken).not.toBe(claimed.claimToken)
  })
})
