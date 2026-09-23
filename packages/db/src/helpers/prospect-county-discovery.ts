import { randomUUID } from 'node:crypto'
import { db } from '../client'
import { CountyDiscoveryCandidate, SubmitCountyDiscoveryInput, ReadCountyDiscoveryInput, DecideCountyDiscoveryInput, ClaimCountyResearchInput } from './prospect-county-research-contract'
import { PROSPECT_GEOGRAPHY_HASH, PROSPECT_GEOGRAPHY_VERSION, geographyHash, planProspectGeography } from './prospect-territory-registry'
import { ProspectGeographyError, assignProspectGeographyInTransaction } from './prospect-territory-actions'
import { countyJson, countyObject, countyConflict, requireCountyActor, requireCountyScope, verifiedCounty, countyTransaction, recoverCountyReceipt, saveCountyReceipt, ownedCountyLease, fenceCountyLease, type CountyResearchActor, type CountyResearchTransaction } from './prospect-county-research'
import type { z } from 'zod'

const KIND='COUNTY_SITE_DISCOVERY'
type Candidate=z.infer<typeof CountyDiscoveryCandidate>
export const normalizeDiscoveryText=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/gu,'').toLowerCase().replace(/&/gu,' and ').replace(/[^a-z0-9]+/gu,' ').trim().replace(/\s+/gu,' ')
export function normalizeDiscoveryAddress(value:string){
  return normalizeDiscoveryText(value).replace(/\b(street|avenue|boulevard|drive|road|lane|circle|court|parkway|highway|north|south|east|west)\b/gu,
    word=>({street:'st',avenue:'ave',boulevard:'blvd',drive:'dr',road:'rd',lane:'ln',circle:'cir',court:'ct',parkway:'pkwy',highway:'hwy',north:'n',south:'s',east:'e',west:'w'}[word]??word))
}
const urlKey=(value:string|null)=>{try{const u=new URL(value??'');return `${u.hostname.toLowerCase().replace(/^www\./u,'')}${u.pathname.replace(/\/$/u,'')}${u.search}`}catch{return null}}
const domain=(value:string|null)=>{try{return new URL(value??'').hostname.toLowerCase().replace(/^www\./u,'')}catch{return null}}
function validateCandidate(candidate:Candidate){
  const evidence=candidate.physicalEvidence
  const plan=planProspectGeography({venueId:'unadmitted-discovery',state:evidence.state,evidence:{...evidence,venueId:'unadmitted-discovery'},asOf:new Date().toISOString().slice(0,10)})
  if(plan.status!=='ASSIGNED')throw new ProspectGeographyError('BAD_REQUEST',plan.reason)
  const anchor=normalizeDiscoveryAddress(evidence.physicalAddress)
  if(!anchor.includes(normalizeDiscoveryAddress(candidate.address.line1))||!anchor.includes(normalizeDiscoveryAddress(candidate.address.city)))
    throw new ProspectGeographyError('BAD_REQUEST','Structured street and city must be supported by the quoted physical-address anchor')
  if(candidate.address.postalCode&&!anchor.includes(candidate.address.postalCode.slice(0,5)))
    throw new ProspectGeographyError('BAD_REQUEST','The supplied postal code is not present in the physical-address anchor')
  return plan
}
/** This is a review-case key, NOT a venue identity. Co-located attractions are
 * kept as distinct observations and require an explicit human identity decision. */
const siteKey=(candidate:Candidate)=>geographyHash({version:PROSPECT_GEOGRAPHY_VERSION,state:candidate.physicalEvidence.state,address:normalizeDiscoveryAddress(candidate.physicalEvidence.physicalAddress)})
async function nativeIdentityCheck(tx:CountyResearchTransaction,candidate:Candidate){
  // Deliberately global, including archived records and geography holds. Full
  // predicate reads inside SERIALIZABLE are rerun on a conflicting admission.
  // No external requests occur in this transaction. Domain equality is never
  // treated as an identity match or an automatic merge instruction.
  const rows=await tx.prospectVenue.findMany({select:{id:true,organizationId:true,territoryId:true,name:true,addressLine1:true,addressLine2:true,city:true,region:true,postalCode:true,website:true,archivedAt:true}})
  const names=new Set([candidate.name,...candidate.aliases].map(normalizeDiscoveryText)),address=normalizeDiscoveryAddress(candidate.physicalEvidence.physicalAddress),site=urlKey(candidate.website)
  const hasSitePath=new URL(candidate.website).pathname.replace(/\//gu,'').length>0
  const matches=rows.flatMap(row=>{
    const reasons:string[]=[]
    if(names.has(normalizeDiscoveryText(row.name)))reasons.push('NAME_OR_ALIAS')
    if(row.addressLine1&&normalizeDiscoveryAddress([row.addressLine1,row.addressLine2,row.city,row.region,row.postalCode].filter(Boolean).join(' '))===address)reasons.push('PHYSICAL_ADDRESS')
    if(hasSitePath&&site===urlKey(row.website))reasons.push('SITE_SPECIFIC_URL')
    return reasons.length?[{venueId:row.id,organizationId:row.organizationId,territoryId:row.territoryId,name:row.name,archived:Boolean(row.archivedAt),reasons}]:[]
  })
  return {matches,sharedDomainCount:rows.filter(row=>domain(row.website)===domain(candidate.website)).length,scanned:rows.length}
}
const visibleMatches=(matches:Awaited<ReturnType<typeof nativeIdentityCheck>>['matches'],actor:CountyResearchActor)=>
  actor.scope.mode==='ALL'?matches:matches.filter(match=>match.territoryId&&actor.scope.mode==='TERRITORIES'&&actor.scope.territoryIds.includes(match.territoryId))
async function resultForActor(tx:CountyResearchTransaction,result:Record<string,unknown>,actor:CountyResearchActor){
  // Persisted global matching IDs are operator-only. Re-project using CURRENT
  // scope on every response/retry instead of trusting a frozen old projection.
  const {globalIdentityMatches:_global,...publicResult}=result
  const candidate=CountyDiscoveryCandidate.safeParse(result.candidate)
  const identities=candidate.success?await nativeIdentityCheck(tx,candidate.data):{matches:[],sharedDomainCount:0,scanned:0}
  return {...publicResult,identityMatches:visibleMatches(identities.matches,actor),
    globalIdentityCheckPerformed:true,unresolvedIdentity:true,canonicalFieldsApplied:false,outreachAuthorized:false}
}

export async function submitCountyDiscovery(raw:unknown,actor:CountyResearchActor){
  requireCountyActor(actor,'prospects.research');requireCountyActor(actor,'prospects.maintain')
  const input=SubmitCountyDiscoveryInput.parse(raw),operation='county-discovery-submit'
  validateCandidate(input.candidate)
  return countyTransaction(async tx=>{
    await verifiedCounty(tx,input.countyGeoid,actor)
    const recovered=await recoverCountyReceipt(tx,actor,operation,input)
    if(recovered)return resultForActor(tx,recovered,actor)
    const lease=await ownedCountyLease(tx,input,actor)
    const cells=ClaimCountyResearchInput.shape.plannedCells.parse(lease.plannedCells)
    if(!cells.some(cell=>cell.id===input.cellId))throw new ProspectGeographyError('BAD_REQUEST','Finding must belong to a cell from the exact leased plan')
    const target=await tx.prospectCountyAssignment.findUnique({where:{modelVersion_countyGeoid:{modelVersion:PROSPECT_GEOGRAPHY_VERSION,countyGeoid:input.candidate.physicalEvidence.countyGeoid}}})
    if(!target)countyConflict('Target physical county is missing from the installed partition')
    const identity=await nativeIdentityCheck(tx,input.candidate),key=siteKey(input.candidate),reviewId=`county_site_${key.slice(0,40)}`,candidateHash=geographyHash(input.candidate)
    // Deterministic physical-site review key coalesces same-site name variants.
    // It never collapses native branches, park components or distinct attractions.
    const reviews=await tx.prospectIntelligenceReview.findMany({where:{kind:KIND},select:{id:true,original:true,status:true,revision:true,decision:true}})
    const existing=reviews.find(review=>review.id===reviewId)
    const priorObservation=existing?await tx.prospectIntelligenceReceipt.findFirst({where:{operation,result:{path:['reviewId'],equals:reviewId},afterState:{path:['candidateHash'],equals:candidateHash}},select:{id:true}}):null
    const crossBoundary=target!.countyGeoid!==input.countyGeoid
    if(!existing)await tx.prospectIntelligenceReview.create({data:{id:reviewId,kind:KIND,sourceHash:key,reason:'New physical-site finding quarantined after global identity review. Co-location and shared operators are not automatic duplicates.',
      original:countyJson({schema:'torchiko.county-site-discovery/v1',siteKey:key,targetCountyGeoid:target!.countyGeoid,targetTerritoryId:target!.territoryId,
        candidate:input.candidate,firstObservationHash:candidateHash,globalIdentityMatches:identity.matches,canonicalFieldsApplied:false}),createdBy:actor.id}})
    else if(!priorObservation){
      const changed=await tx.prospectIntelligenceReview.updateMany({where:{id:reviewId,revision:existing.revision},data:{revision:{increment:1},status:'OPEN',
        reason:'Additional physical-site observation retained. Reconcile all observations before linking or creating distinct native venues; prior decisions remain in immutable receipts.'}})
      if(changed.count!==1)countyConflict('Discovery review changed concurrently')
    }
    await fenceCountyLease(tx,input,actor)
    const saved=await saveCountyReceipt(tx,actor,operation,input,{review:existing??null},
      {reviewId,countyGeoid:target!.countyGeoid,targetTerritoryId:target!.territoryId,claimedCountyGeoid:input.countyGeoid,generation:input.generation,cellId:input.cellId,
        candidate:input.candidate,candidateHash,globalIdentityMatches:identity.matches,globalIdentityCheckPerformed:true,globalNativeRecordsChecked:identity.scanned,
        crossBoundary,disposition:crossBoundary?'CROSS_BOUNDARY_HANDOFF':'QUARANTINED',coalescedReview:Boolean(existing),
        priorEquivalentObservation:Boolean(priorObservation),sharedDomainIsNotIdentity:true,canonicalFieldsApplied:false,outreachAuthorized:false})
    return resultForActor(tx,saved,actor)
  })
}
export async function readCountyDiscoveries(raw:unknown,actor:CountyResearchActor){
  requireCountyActor(actor,'prospects.read')
  const input=ReadCountyDiscoveryInput.parse(raw)
  return countyTransaction(async tx=>{
  const where={kind:KIND,...(input.reviewId?{id:input.reviewId}:{}),...(input.status==='ALL'?{}:{status:input.status}),
    AND:[...(input.countyGeoid?[{original:{path:['targetCountyGeoid'],equals:input.countyGeoid}}]:[]),
      ...(actor.scope.mode==='ALL'?[]:[{OR:actor.scope.territoryIds.map(id=>({original:{path:['targetTerritoryId'],equals:id}}))}])]}
  const [total,rows]=await Promise.all([tx.prospectIntelligenceReview.count({where}),tx.prospectIntelligenceReview.findMany({where,orderBy:[{createdAt:'desc'},{id:'asc'}],skip:(input.page-1)*input.limit,take:input.limit})])
  const items=[]
  for(const row of rows){
    const original=countyObject(row.original)
    const receiptWhere={operation:'county-discovery-submit',result:{path:['reviewId'],equals:row.id}}
    const [observationCount,observations]=await Promise.all([tx.prospectIntelligenceReceipt.count({where:receiptWhere}),tx.prospectIntelligenceReceipt.findMany({where:receiptWhere,orderBy:[{createdAt:'desc'},{id:'asc'}],take:50})])
    const candidate=CountyDiscoveryCandidate.parse(original.candidate),identities=await nativeIdentityCheck(tx,candidate)
    let decision=row.decision
    if(actor.scope.mode!=='ALL'&&typeof countyObject(decision).venueId==='string'){
      const visible=await tx.prospectVenue.findFirst({where:{id:String(countyObject(decision).venueId),territoryId:{in:[...actor.scope.territoryIds]}},select:{id:true}})
      if(!visible)decision={decision:'RESOLVED_OUTSIDE_CURRENT_VENUE_GRANT',reason:'The linked native venue is outside the caller\'s current grant. No related organization, branch or source identifiers are exposed.'}
    }
    items.push({reviewId:row.id,revision:row.revision,status:row.status,reason:row.reason,decision,
      countyGeoid:String(original.targetCountyGeoid),territoryId:String(original.targetTerritoryId),candidate,
      identityMatches:visibleMatches(identities.matches,actor),sharedDomainIsNotIdentity:true,observationCount,observationsTruncated:observationCount>observations.length,
      observations:observations.map(receipt=>({receiptId:receipt.id,actorId:receipt.actorId,actorType:receipt.actorType,at:receipt.createdAt,
        candidate:CountyDiscoveryCandidate.parse(countyObject(receipt.result).candidate),crossBoundary:countyObject(receipt.result).crossBoundary===true})),
      canonicalFieldsApplied:false,outreachAuthorized:false})
  }
  return {items,total,page:input.page,limit:input.limit,hasMore:input.page*input.limit<total,automaticAdmission:false}
  })
}

export async function decideCountyDiscovery(raw:unknown,actor:CountyResearchActor){
  requireCountyActor(actor,'prospects.maintain')
  if(actor.type!=='HUMAN')throw new ProspectGeographyError('FORBIDDEN','Only an authenticated human may decide a new-site identity review')
  const input=DecideCountyDiscoveryInput.parse(raw),operation='county-discovery-review'
  return countyTransaction(async tx=>{
    const review=await tx.prospectIntelligenceReview.findUnique({where:{id:input.reviewId}})
    if(!review||review.kind!==KIND)throw new ProspectGeographyError('NOT_FOUND','Native discovery review is unavailable')
    const original=countyObject(review.original)
    requireCountyScope(actor,typeof original.targetTerritoryId==='string'?original.targetTerritoryId:null)
    const recovered=await recoverCountyReceipt(tx,actor,operation,input);if(recovered)return recovered
    if(review.status!=='OPEN'||review.revision!==input.expectedRevision)countyConflict('The discovery review changed; reload all current observations')
    const observation=await tx.prospectIntelligenceReceipt.findUnique({where:{id:input.observationReceiptId}}),observed=countyObject(observation?.result)
    if(observation?.operation!=='county-discovery-submit'||observed.reviewId!==review.id)throw new ProspectGeographyError('BAD_REQUEST','Choose an immutable observation belonging to this review')
    const candidate=CountyDiscoveryCandidate.parse(observed.candidate);validateCandidate(candidate)
    const county=await verifiedCounty(tx,candidate.physicalEvidence.countyGeoid,actor),identity=await nativeIdentityCheck(tx,candidate)
    if(original.targetCountyGeoid!==county.countyGeoid&&actor.scope.mode!=='ALL')throw new ProspectGeographyError('FORBIDDEN','Conflicting physical-county observations require a platform-wide human review')
    let venueId:string|null=null,organizationId:string|null=null
    if(input.decision==='LINK_EXISTING'){
      if(!input.existingVenueId)throw new ProspectGeographyError('BAD_REQUEST','Select the exact existing native venue')
      const venue=await tx.prospectVenue.findUnique({where:{id:input.existingVenueId}})
      if(!venue)throw new ProspectGeographyError('NOT_FOUND','Selected native venue is unavailable')
      requireCountyScope(actor,venue.territoryId)
      venueId=venue.id;organizationId=venue.organizationId
      // Linking observation evidence does NOT silently replace an existing site's
      // identity, address, county, contact permissions or active research job.
    }else if(input.decision==='CREATE_DISTINCT'){
      if(identity.matches.length>100||identity.matches.some(match=>!input.acknowledgedIdentityMatchIds.includes(match.venueId)))
        countyConflict('A current global identity candidate has not been explicitly reviewed as distinct; no native venue was created')
      if(input.acknowledgedIdentityMatchIds.some(id=>!identity.matches.some(match=>match.venueId===id)))
        countyConflict('The identity candidate set changed; reload before admitting a distinct site')
      if(input.organizationId){
        const organization=await tx.prospectOrganization.findUnique({where:{id:input.organizationId},include:{venues:{select:{territoryId:true}}}})
        if(!organization||organization.archivedAt)throw new ProspectGeographyError('NOT_FOUND','Selected existing organization is unavailable')
        for(const venue of organization.venues)requireCountyScope(actor,venue.territoryId)
        organizationId=organization.id
      }else{
        const organization=await tx.prospectOrganization.create({data:{canonicalName:candidate.name,normalizedName:normalizeDiscoveryText(candidate.name),
          website:candidate.website,normalizedDomain:domain(candidate.website),source:'HUMAN_REVIEWED_COUNTY_DISCOVERY',createdBy:actor.id,updatedBy:actor.id,
          researchProvenance:countyJson([{reviewId:review.id,observationReceiptId:observation!.id,reason:input.reason}])}})
        organizationId=organization.id
      }
      const venue=await tx.prospectVenue.create({data:{organizationId:organizationId!,name:candidate.name,normalizedName:normalizeDiscoveryText(candidate.name),
        website:candidate.website,normalizedDomain:domain(candidate.website),venueType:candidate.category,addressLine1:candidate.address.line1,addressLine2:candidate.address.line2??null,
        city:candidate.address.city,region:candidate.physicalEvidence.state,postalCode:candidate.address.postalCode??null,country:'US',
        territoryId:county.territoryId,createdBy:actor.id,updatedBy:actor.id,researchSources:countyJson([{reviewId:review.id,observationReceiptId:observation!.id}])}})
      venueId=venue.id
      await assignProspectGeographyInTransaction({idempotencyKey:`county-admission-${randomUUID()}`,venueId:venue.id,expectedVenueUpdatedAt:venue.updatedAt.toISOString(),expectedRevision:0,
        expectedRegistryHash:PROSPECT_GEOGRAPHY_HASH,evidence:{...candidate.physicalEvidence,venueId:venue.id}},actor,tx)
    }
    if(venueId&&organizationId)await tx.prospectSourceEvidence.create({data:{organizationId,venueId,sourceType:'HUMAN_REVIEWED_DISCOVERY_OBSERVATION',sourceUrl:candidate.website,
      sourceLabel:'Reviewed physical-site identity; public contact routes remain source-only and grant no permission',createdBy:actor.id,researchedAt:new Date(candidate.physicalEvidence.observedAt),
      capturedValue:countyJson({candidate,reviewId:review.id,observationReceiptId:observation!.id,decision:input.decision,reason:input.reason,outreachAuthorized:false})}})
    const decision={decision:input.decision,reason:input.reason,actorId:actor.id,at:new Date().toISOString(),venueId,organizationId,observationReceiptId:observation!.id}
    const changed=await tx.prospectIntelligenceReview.updateMany({where:{id:review.id,revision:input.expectedRevision,status:'OPEN'},data:{status:'RESOLVED',revision:{increment:1},decision:countyJson(decision)}})
    if(changed.count!==1)countyConflict('Concurrent identity decision; no partial venue admission committed')
    return saveCountyReceipt(tx,actor,operation,input,{reviewRevision:review.revision,globalIdentityMatches:identity.matches},
      {reviewId:review.id,countyGeoid:county.countyGeoid,revision:review.revision+1,...decision,canonicalFieldsApplied:input.decision==='CREATE_DISTINCT',outreachAuthorized:false})
  })
}
