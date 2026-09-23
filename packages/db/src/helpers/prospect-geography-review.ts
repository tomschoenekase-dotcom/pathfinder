import type { Prisma } from '@prisma/client'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { db } from '../client'
import {
  ProposeProspectGeographyInput, GeographyProposalListInput,
  ResolveProspectGeographyProposalInput,
} from './prospect-territory-contract'
import {
  PROSPECT_GEOGRAPHY_HASH, PROSPECT_GEOGRAPHY_VERSION,
  geographyHash, planProspectGeography,
} from './prospect-territory-registry'
import {
  assignProspectGeographyInTransaction, ProspectGeographyError,
  type GeographyActor, type ProspectGeographyTransaction,
} from './prospect-territory-actions'

const KIND = 'PHYSICAL_GEOGRAPHY_PROPOSAL'
type Tx = ProspectGeographyTransaction & Pick<typeof db, 'prospectIntelligenceReview'|'prospectResearchJob'|'prospectResearchAttempt'>
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function requireCapability(actor: GeographyActor, capability: string) {
  if (!actor.id.trim() || !actor.runId.trim() || !actor.capabilities.includes(capability))
    throw new ProspectGeographyError('FORBIDDEN', `Current actor/run requires ${capability}`)
}
function requireScope(actor: GeographyActor, territoryId: string | null) {
  if (actor.scope.mode !== 'ALL' && (!territoryId || !actor.scope.territoryIds.includes(territoryId)))
    throw new ProspectGeographyError('FORBIDDEN', 'The current native territory is outside the actor grant')
}
async function transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await db.$transaction(run, { isolationLevel: 'Serializable', timeout: 30000, maxWait: 5000 }) }
    catch (error) {
      if (error instanceof PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(error.code) && attempt < 2) continue
      throw error
    }
  }
  throw new ProspectGeographyError('CONFLICT', 'Concurrent proposal; reload the current venue')
}
async function model(tx: Tx) {
  const value = await tx.prospectGeographyModel.findUnique({ where: { version: PROSPECT_GEOGRAPHY_VERSION } })
  if (!value || value.registryHash !== PROSPECT_GEOGRAPHY_HASH)
    throw new ProspectGeographyError('CONFLICT', 'The approved registry is not installed with this release hash')
}
async function venueFor(tx: Pick<Tx, 'prospectVenue'>, venueId: string, actor: GeographyActor) {
  const venue = await tx.prospectVenue.findUnique({ where: { id: venueId }, include: { geography: true } })
  if (!venue) throw new ProspectGeographyError('NOT_FOUND', 'Native venue not found')
  requireScope(actor, venue.territoryId)
  return venue
}
const receiptIdentity = (operation: string, key: string, actor: GeographyActor) =>
  `geop_rx_${geographyHash({ operation, actor: actor.id, run: actor.runId, key }).slice(0, 32)}`
async function prior(tx: Tx, id: string, hash: string) {
  const receipt = await tx.prospectIntelligenceReceipt.findUnique({ where: { id } })
  if (!receipt) return null
  if (receipt.inputHash !== hash) throw new ProspectGeographyError('CONFLICT', 'Retry key belongs to a different payload')
  return { ...object(receipt.result), receiptId: id, replayed: true }
}
async function receipt(tx: Tx, actor: GeographyActor, input: { idempotencyKey: string }, operation: string,
  venueId: string, before: unknown, result: Record<string, unknown>) {
  const id = receiptIdentity(operation, input.idempotencyKey, actor)
  await tx.prospectIntelligenceReceipt.create({ data: {
    id, actorId: actor.id, actorType: actor.type, runId: actor.runId, idempotencyKey: input.idempotencyKey,
    operation, inputHash: geographyHash({ operation, input }), venueId,
    beforeState: json(before), afterState: json(result), result: json(result),
  } })
  await tx.auditLog.create({ data: {
    actorId: actor.id, actorType: actor.type, actorRole: actor.type === 'AGENT' ? 'AGENT' : 'PLATFORM_ADMIN',
    ...(actor.type === 'AGENT' ? { agentRunId: actor.runId } : {}),
    action: `prospect.${operation}`, targetType: 'ProspectVenue', targetId: venueId,
    beforeState: json(before), afterState: json(result),
  } })
  return { ...result, receiptId: id, replayed: false }
}

/** Research workers submit evidence to the existing review queue; they never admit a county. */
export async function proposeProspectGeography(raw: unknown, actor: GeographyActor) {
  requireCapability(actor, 'prospects.maintain')
  const input = ProposeProspectGeographyInput.parse(raw), operation = 'geography-propose'
  return transaction(async tx => {
    await model(tx)
    const venue = await venueFor(tx, input.venueId, actor)
    const recovered = await prior(tx, receiptIdentity(operation, input.idempotencyKey, actor), geographyHash({ operation, input }))
    if (recovered) return recovered
    const job=await tx.prospectResearchJob.findUnique({where:{organizationId:venue.organizationId}})
    if(job?.status==='CLAIMED'){
      const binding=input.researchClaim,now=new Date()
      if(!binding||binding.jobId!==job.id||binding.claimToken!==job.claimToken||job.claimOwnerId!==actor.id||job.claimAgentRunId!==actor.runId||!job.claimExpiresAt||job.claimExpiresAt<=now)
        throw new ProspectGeographyError('CONFLICT','Existing organization research is claimed; use its current exact actor/run/token or wait for a fresh claim')
      const attempt=await tx.prospectResearchAttempt.findUnique({where:{claimToken:binding.claimToken}})
      if(!attempt||attempt.status!=='CLAIMED'||attempt.jobId!==job.id||attempt.agentRunId!==actor.runId||attempt.leaseExpiresAt<=now||
        (typeof object(attempt.usage).venueId==='string'&&object(attempt.usage).venueId!==venue.id))
        throw new ProspectGeographyError('CONFLICT','Research attempt does not cover this current native location')
      const fence=await tx.prospectResearchJob.updateMany({where:{id:job.id,status:'CLAIMED',claimToken:binding.claimToken,claimOwnerId:actor.id,claimAgentRunId:actor.runId,claimExpiresAt:{gt:now}},data:{updatedAt:now}})
      if(fence.count!==1)throw new ProspectGeographyError('CONFLICT','Research claim changed before the evidence proposal could be retained')
    }else if(input.researchClaim)throw new ProspectGeographyError('CONFLICT','The supplied research claim is no longer current')
    if (venue.archivedAt || venue.updatedAt.toISOString() !== input.expectedVenueUpdatedAt ||
        (venue.geography?.revision ?? 0) !== input.expectedRevision)
      throw new ProspectGeographyError('CONFLICT', 'Venue or geography changed; refresh before proposing evidence')
    const plan = planProspectGeography({ venueId: venue.id, state: venue.region,
      evidence: input.evidence, asOf: new Date().toISOString().slice(0, 10) })
    if (plan.status !== 'ASSIGNED') throw new ProspectGeographyError('BAD_REQUEST', plan.reason)
    const county = await tx.prospectCountyAssignment.findUnique({ where: { modelVersion_countyGeoid: {
      modelVersion: PROSPECT_GEOGRAPHY_VERSION, countyGeoid: plan.countyGeoid,
    } } })
    if (!county) throw new ProspectGeographyError('CONFLICT', 'County bridge missing')
    requireScope(actor, county.territoryId)
    const { idempotencyKey: _key, researchClaim, ...proposal } = input
    // Cross-worker identical proposals converge without changing any venue identity.
    const reviewId = `geop_${geographyHash(proposal).slice(0, 32)}`
    const existing = await tx.prospectIntelligenceReview.findUnique({ where: { id: reviewId } })
    if (existing && (existing.kind !== KIND || existing.venueId !== venue.id || existing.sourceHash !== geographyHash(proposal)))
      throw new ProspectGeographyError('CONFLICT', 'Review identity collision; original evidence preserved')
    const evidenceId = `geop_ev_${reviewId}`
    if (!existing) {
      await tx.prospectSourceEvidence.create({ data: {
        id: evidenceId, organizationId: venue.organizationId, venueId: venue.id,
        sourceType: 'PROPOSED_PHYSICAL_COUNTY', sourceUrl: input.evidence.addressSourceUrl,
        sourceLabel: 'Proposed physical county; not an admitted geography or contact permission',
        researchedAt: new Date(input.evidence.observedAt), capturedValue: json(proposal), createdBy: actor.id,
      } })
      await tx.prospectIntelligenceReview.create({ data: {
        id: reviewId, venueId: venue.id, kind: KIND, sourceHash: geographyHash(proposal),
        reason: 'Review the physical visitor address and authoritative county evidence before changing canonical research ownership.',
        original: json({ schema: 'torchiko.geography-proposal/v1', proposal, evidenceId,
          territoryCode: plan.territoryCode, submittedBy: actor.id, submittedRunId: actor.runId,
          researchClaim:researchClaim??null,canonicalFieldsApplied: false }), createdBy: actor.id,
      } })
    }
    return receipt(tx, actor, input, operation, venue.id, { geographyRevision: input.expectedRevision }, {
      venueId: venue.id, reviewId, evidenceId, reviewStatus: existing?.status ?? 'OPEN',
      deduplicated: Boolean(existing), canonicalFieldsApplied: false, outreachAuthorized: false,
    })
  })
}

export async function listProspectGeographyProposals(raw: unknown, actor: GeographyActor) {
  requireCapability(actor, 'prospects.read')
  const input = GeographyProposalListInput.parse(raw)
  const venue = await venueFor(db, input.venueId, actor)
  const where = { venueId: venue.id, kind: KIND, ...(input.status === 'ALL' ? {} : { status: input.status }),
    ...(actor.scope.mode==='ALL'?{}:{venue:{territoryId:{in:[...actor.scope.territoryIds]}}}) }
  const [total, rows] = await Promise.all([
    db.prospectIntelligenceReview.count({ where }),
    db.prospectIntelligenceReview.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (input.page - 1) * input.limit, take: input.limit }),
  ])
  const items = rows.map(row => {
    const original = object(row.original)
    const parsed = ProposeProspectGeographyInput.safeParse({ ...object(original.proposal), idempotencyKey: 'read-only' })
    const proposal = parsed.success ? parsed.data : null
    return { reviewId: row.id, revision: row.revision, status: row.status, reason: row.reason,
      proposal, evidenceId: typeof original.evidenceId === 'string' ? original.evidenceId : null,
      decision: row.decision, createdAt: row.createdAt,
      stale: !proposal || venue.updatedAt.toISOString() !== proposal.expectedVenueUpdatedAt ||
        (venue.geography?.revision ?? 0) !== proposal.expectedRevision,
    }
  })
  return { venueId: venue.id, items, total, page: input.page, limit: input.limit,
    hasMore: input.page * input.limit < total, canonicalFieldsApplied: false }
}

/** Human-only decision and canonical assignment share ONE serializable transaction. */
export async function resolveProspectGeographyProposal(raw: unknown, actor: GeographyActor) {
  requireCapability(actor, 'prospects.maintain')
  if (actor.type !== 'HUMAN') throw new ProspectGeographyError('FORBIDDEN', 'Only an authenticated human operator may decide a geography proposal')
  const input = ResolveProspectGeographyProposalInput.parse(raw), operation = 'geography-review'
  return transaction(async tx => {
    await model(tx)
    const review = await tx.prospectIntelligenceReview.findUnique({ where: { id: input.reviewId } })
    if (!review || review.kind !== KIND || !review.venueId) throw new ProspectGeographyError('NOT_FOUND', 'Geography proposal not found')
    const venue = await venueFor(tx, review.venueId, actor)
    const recovered = await prior(tx, receiptIdentity(operation, input.idempotencyKey, actor), geographyHash({ operation, input }))
    if (recovered) return recovered
    if (review.status !== 'OPEN' || review.revision !== input.expectedReviewRevision)
      throw new ProspectGeographyError('CONFLICT', 'Review already changed; reload its current decision')
    const original = object(review.original)
    const proposal = ProposeProspectGeographyInput.parse({ ...object(original.proposal),
      idempotencyKey: `review-assignment-${geographyHash({ reviewId: review.id, revision: review.revision }).slice(0, 40)}` })
    if (proposal.venueId !== venue.id) throw new ProspectGeographyError('CONFLICT', 'Proposal venue identity mismatch')
    const assignment = input.decision === 'ACCEPT'
      ? await assignProspectGeographyInTransaction(proposal, actor, tx) : null
    const changed = await tx.prospectIntelligenceReview.updateMany({
      where: { id: review.id, revision: input.expectedReviewRevision, status: 'OPEN' },
      data: { status: 'RESOLVED', revision: { increment: 1 }, decision: json({
        decision: input.decision, reason: input.reason, actorId: actor.id,
        at: new Date().toISOString(), assignmentReceiptId: assignment?.receiptId ?? null,
      }) },
    })
    if (changed.count !== 1) throw new ProspectGeographyError('CONFLICT', 'Concurrent review decision; no partial assignment committed')
    return receipt(tx, actor, input, operation, venue.id, { reviewRevision: review.revision }, {
      venueId: venue.id, reviewId: review.id, revision: review.revision + 1, decision: input.decision,
      canonicalFieldsApplied: assignment !== null, assignment, outreachAuthorized: false,
    })
  })
}
