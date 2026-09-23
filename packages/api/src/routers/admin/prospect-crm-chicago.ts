import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { chicagoLifecycleInput, chicagoRankingOverrideInput, chicagoRankingRefreshInput } from '../../chicago-intelligence-maintenance-contract'
import { maintainChicagoVenue, overrideChicagoVenueRanking, refreshChicagoVenueRankings } from '../../chicago-intelligence-maintenance'
import { chicagoResearchPreviewInput, chicagoResearchQueueInput, chicagoResearchClaimInput, chicagoResearchCompleteInput, chicagoResearchReleaseInput } from '../../chicago-intelligence-research-contract'
import { previewChicagoResearch, queueChicagoResearch, claimChicagoResearch, completeChicagoResearch, releaseChicagoResearch } from '../../chicago-intelligence-research'
import { adminProcedure } from '../../trpc'
import { chicagoDirectoryInput, chicagoVenueInput, chicagoAddInput, chicagoChangeInput, chicagoDuplicateInput, chicagoReviewInput, chicagoAppendEvidenceInput } from '../../chicago-intelligence-contract'
import { listChicagoVenues, getChicagoVenue, getChicagoHealth, addChicagoVenue, changeChicagoVenue, proposeChicagoDuplicate, resolveChicagoReview, appendChicagoEvidence, ChicagoIntelligenceError, type ChicagoActor } from '../../chicago-intelligence-service'

const scope = { mode: 'ALL' } as const
const actor = (id:string):ChicagoActor => ({id,type:'HUMAN',runId:'admin-chicago-workspace',scope,capabilities:['prospects.read','prospects.maintain']})
async function execute<T>(call:()=>Promise<T>) {
  try { return await withTenantIsolationBypass(() => call()) } catch(error) {
    if(error instanceof ChicagoIntelligenceError) throw new TRPCError({code:error.code==='INVALID_INPUT'?'BAD_REQUEST':error.code,message:error.message})
    throw error
  }
}
export const adminProspectCrmChicagoRouter=router({
  maintainChicagoVenue:adminProcedure.input(chicagoLifecycleInput).mutation(({input,ctx})=>execute(()=>maintainChicagoVenue(input,actor(ctx.session.userId)))),
  overrideChicagoVenueRanking:adminProcedure.input(chicagoRankingOverrideInput).mutation(({input,ctx})=>execute(()=>overrideChicagoVenueRanking(input,actor(ctx.session.userId)))),
  refreshChicagoVenueRankings:adminProcedure.input(chicagoRankingRefreshInput).mutation(({input,ctx})=>execute(()=>refreshChicagoVenueRankings(input,actor(ctx.session.userId)))),
  previewChicagoResearch:adminProcedure.input(chicagoResearchPreviewInput).query(({input})=>execute(()=>previewChicagoResearch(input,scope))),
  queueChicagoResearch:adminProcedure.input(chicagoResearchQueueInput).mutation(({input,ctx})=>execute(()=>queueChicagoResearch(input,actor(ctx.session.userId)))),
  claimChicagoResearch:adminProcedure.input(chicagoResearchClaimInput).mutation(({input,ctx})=>execute(()=>claimChicagoResearch(input,actor(ctx.session.userId)))),
  completeChicagoResearch:adminProcedure.input(chicagoResearchCompleteInput).mutation(({input,ctx})=>execute(()=>completeChicagoResearch(input,actor(ctx.session.userId)))),
  releaseChicagoResearch:adminProcedure.input(chicagoResearchReleaseInput).mutation(({input,ctx})=>execute(()=>releaseChicagoResearch(input,actor(ctx.session.userId)))),
  listChicagoVenues:adminProcedure.input(chicagoDirectoryInput).query(({input})=>execute(()=>listChicagoVenues(input,scope))),
  getChicagoVenue:adminProcedure.input(chicagoVenueInput).query(({input})=>execute(()=>getChicagoVenue(input.venueId,scope))),
  getChicagoHealth:adminProcedure.input(z.object({}).strict()).query(()=>execute(()=>getChicagoHealth(scope))),
  addChicagoVenue:adminProcedure.input(chicagoAddInput).mutation(({input,ctx})=>execute(()=>addChicagoVenue(input,actor(ctx.session.userId)))),
  changeChicagoVenue:adminProcedure.input(chicagoChangeInput).mutation(({input,ctx})=>execute(()=>changeChicagoVenue(input,actor(ctx.session.userId)))),
  proposeChicagoDuplicate:adminProcedure.input(chicagoDuplicateInput).mutation(({input,ctx})=>execute(()=>proposeChicagoDuplicate(input,actor(ctx.session.userId)))),
  resolveChicagoReview:adminProcedure.input(chicagoReviewInput).mutation(({input,ctx})=>execute(()=>resolveChicagoReview(input,actor(ctx.session.userId)))),
  appendChicagoEvidence:adminProcedure.input(chicagoAppendEvidenceInput).mutation(({input,ctx})=>execute(()=>appendChicagoEvidence(input,actor(ctx.session.userId)))),
})
