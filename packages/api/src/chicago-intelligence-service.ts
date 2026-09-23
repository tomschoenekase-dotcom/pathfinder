import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { db, CHICAGO_RANKING_VERSION, rankChicagoVenue, chicagoOperatingWhere, PROSPECT_GEOGRAPHY_VERSION, type ChicagoRankingInput } from '@pathfinder/db'
import {
  chicagoDirectoryInput, chicagoAddInput, chicagoChangeInput, chicagoDuplicateInput, chicagoReviewInput, chicagoAppendEvidenceInput,
  type ChicagoDirectoryResult, type ChicagoVenueRow, type ChicagoVenueDetail, type ChicagoHealth,
  type ChicagoCoverage,
} from './chicago-intelligence-contract'

export type ChicagoScope = { mode: 'ALL' } | { mode: 'TERRITORIES'; territoryIds: readonly string[] }
export type ChicagoActor = { id: string; type: 'HUMAN' | 'AGENT' | 'SYSTEM'; runId: string; scope: ChicagoScope; capabilities: readonly string[] }
export type ChicagoTransaction = Pick<typeof db, 'prospectVenue'|'prospectVenueIntelligence'|'prospectVenueRanking'|'prospectIntelligenceReview'|'prospectIntelligenceReceipt'|'prospectTerritory'|'prospectOrganization'|'prospectOpportunity'|'prospectSourceEvidence'|'prospectResearchJob'|'prospectResearchAttempt'|'auditLog'|'prospectGeographyModel'>
type Tx = ChicagoTransaction
export class ChicagoIntelligenceError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID_INPUT', message: string) { super(message); this.name = 'ChicagoIntelligenceError' }
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export const intelligenceHash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
export const intelligenceJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
// Exact canonical workbook identity normalization; never let accents or '&' create new aliases.
export const normalizeChicagoIdentity = (name: string, city: string, state: string) => [name, city, state].map(v => v.normalize('NFKD').replace(/[\u0300-\u036f]/gu,'').toLowerCase().replace(/&/gu,' and ').replace(/[^a-z0-9]+/gu,' ').trim()).join('|')
export function chicagoWebsiteDomain(value:string|null|undefined):string|null {
  try { const parsed=new URL(value??'');return ['http:','https:'].includes(parsed.protocol)?parsed.hostname.toLowerCase().replace(/^www\./,''):null } catch { return null }
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const dateOnly = () => new Date().toISOString().slice(0, 10)
const scopeWhere = (scope: ChicagoScope) => scope.mode === 'ALL' ? {} : { territoryId: { in: [...scope.territoryIds] } }
const includeVenue = {
  intelligence: true, intelligenceReviews: { where: { status: 'OPEN' } },
  territory: true, organization: { include: { opportunity: true } }, contacts: true,
} satisfies Prisma.ProspectVenueInclude
type NativeVenue = Prisma.ProspectVenueGetPayload<{include: typeof includeVenue}>

function rankingFor(venue: NativeVenue) {
  const stored = object(venue.intelligence?.rankingInput) as Partial<ChicagoRankingInput>
  const suppressed=venue.contacts.some(c=>!c.archivedAt&&(c.doNotContact||c.suppressedAt||c.unsubscribedAt||['OPTED_OUT','PROHIBITED'].includes(c.permissionState)))
  return rankChicagoVenue({ ...stored, venueId: venue.id, asOf: dateOnly(), territory: 'Chicago Metro', venueType: venue.venueType,
    contacts:(stored.contacts??[]).map(contact=>({...contact,suppressed:contact.suppressed||suppressed})),
    archived: Boolean(venue.archivedAt||venue.organization.archivedAt), conflicts: venue.intelligenceReviews.map(r => r.reason),
  })
}
function rowFor(venue: NativeVenue): ChicagoVenueRow {
  const ranking = rankingFor(venue)
  const activeContacts = venue.contacts.filter(c => !c.archivedAt)
  const suppressed = activeContacts.some(c => c.doNotContact || c.suppressedAt || c.unsubscribedAt || ['OPTED_OUT', 'PROHIBITED'].includes(c.permissionState))
  const verified = ranking.contactability.value !== null && ranking.contactability.value > 0
  const claims = Array.isArray(venue.intelligence?.contactClaims) ? venue.intelligence.contactClaims : []
  return {
    venueId: venue.id, organizationId: venue.organizationId, name: venue.name, organizationName: venue.organization.canonicalName,
    city: venue.city, state: venue.region, category: venue.venueType, website: venue.website,
    chicagoProper: venue.city?.trim().toLowerCase() === 'chicago' && venue.region?.toUpperCase() === 'IL',
    revision: venue.intelligence?.revision ?? 0, relationshipState: venue.organization.opportunity?.stage ?? 'DISCOVERED',
    confidence: venue.intelligence?.confidence ?? 'unknown', stale: ranking.evidenceFreshness.value === null || ranking.evidenceFreshness.value < 75,
    contactability: suppressed ? 'suppressed' : verified ? 'verified' : claims.length || activeContacts.some(c => c.email || c.phone) ? 'source-only' : 'missing',
    ranking, reviewCount: venue.intelligenceReviews.length,
  }
}
function coverageFor(rows: ChicagoVenueRow[]): ChicagoCoverage {
  return { total: rows.length, proper: rows.filter(r => r.chicagoProper).length, metro: rows.filter(r => !r.chicagoProper).length,
    ranked: rows.filter(r => ['evidence-backed','provisional-heuristic'].includes(r.ranking.state)).length,
    needsResearch: rows.filter(r => r.ranking.researchGaps.length > 0).length, stale: rows.filter(r => r.stale).length,
    conflicted: rows.filter(r => r.reviewCount > 0).length, quarantined: rows.reduce((n,r) => n+r.reviewCount,0) }
}
async function market(scope: ChicagoScope, lifecycle: 'active'|'archived'|'all' = 'active') {
  return db.prospectVenue.findMany({where:{ AND:[chicagoOperatingWhere()], ...(lifecycle==='active'?{archivedAt:null,organization:{archivedAt:null}}:lifecycle==='archived'?{archivedAt:{not:null}}:{}), ...scopeWhere(scope)}, include:includeVenue, orderBy:{id:'asc'}})
}
export async function queryChicagoVenueRows(raw: unknown, scope: ChicagoScope): Promise<ChicagoDirectoryResult> {
  const input = chicagoDirectoryInput.parse(raw)
  const all = (await market(scope,input.lifecycle)).map(rowFor)
  let rows = all.filter(row =>
    (!input.query || [row.name,row.organizationName,row.city,row.state,row.category].join(' ').toLowerCase().includes(input.query.toLowerCase())) &&
    (input.geography === 'all' || row.chicagoProper === (input.geography === 'chicago-proper')) &&
    (!input.city || row.city === input.city) && (!input.state || row.state === input.state) &&
    (!input.category || row.category === input.category) && (!input.rankingState || row.ranking.state === input.rankingState) &&
    (!input.contactability || row.contactability === input.contactability) && (input.stale === undefined || row.stale === input.stale))
  rows.sort((a,b) => {
    for (const sort of input.sorts) {
      const av = ['name','city','category'].includes(sort.field) ? a[sort.field as 'name'|'city'|'category'] : a.ranking[sort.field as 'productFit'].value
      const bv = ['name','city','category'].includes(sort.field) ? b[sort.field as 'name'|'city'|'category'] : b.ranking[sort.field as 'productFit'].value
      if (av == null || bv == null) { if (av == null && bv != null) return 1; if (bv == null && av != null) return -1; continue }
      const comparison = typeof av === 'number' && typeof bv === 'number' ? av-bv : String(av).localeCompare(String(bv), 'en')
      if (comparison) return comparison * (sort.direction === 'asc' ? 1 : -1)
    }
    return a.venueId.localeCompare(b.venueId)
  })
  const total = rows.length
  const facet = (field:'category'|'city'|'state') => [...new Set(all.map(r => r[field]).filter((v):v is string => Boolean(v)))].sort()
  return {items:rows,total,page:input.page,pageSize:input.pageSize,facets:{categories:facet('category'),cities:facet('city'),states:facet('state')},coverage:coverageFor(all)}
}
export async function listChicagoVenues(raw: unknown, scope: ChicagoScope): Promise<ChicagoDirectoryResult> {
  const result=await queryChicagoVenueRows(raw,scope)
  return {...result,items:result.items.slice((result.page-1)*result.pageSize,result.page*result.pageSize)}
}
export async function scopedVenue(venueId: string, scope: ChicagoScope, client: Pick<typeof db, 'prospectVenue'> = db) {
  const venue = await client.prospectVenue.findFirst({where:{id:venueId,AND:[chicagoOperatingWhere()],...scopeWhere(scope)},include:includeVenue})
  if (!venue) throw new ChicagoIntelligenceError('NOT_FOUND','Chicago venue is missing or outside the current scope')
  return venue
}
export async function getChicagoVenue(venueId:string,scope:ChicagoScope):Promise<ChicagoVenueDetail> {
  const venue = await scopedVenue(venueId,scope)
  const [sources,imports,audit] = await Promise.all([
    db.prospectSourceEvidence.findMany({where:{venueId},orderBy:[{createdAt:'desc'},{id:'asc'}]}),
    db.prospectImportSourceRecord.findMany({where:{canonicalVenueId:venueId,recordKind:'PROSPECT'},orderBy:{createdAt:'desc'}}),
    db.prospectIntelligenceReceipt.findMany({where:{OR:[{venueId},{operation:'ranking-refresh',result:{path:['venues'],array_contains:[{venueId}]}},{operation:'research-queue',result:{path:['jobs'],array_contains:[{venueId}]}}]},orderBy:{createdAt:'desc'},take:100}),
  ])
  const row = rowFor(venue)
  return {...row,organization:{id:venue.organizationId,name:venue.organization.canonicalName,identityNote:'Organization is the CRM relationship owner; this venue is one physical location. Shared operators are review proposals until evidenced.'},
    fields:object(venue.intelligence?.fields) as ChicagoVenueDetail['fields'],
    sources:sources.map(s=>({id:s.id,url:s.sourceUrl,label:s.sourceLabel,researchedAt:s.researchedAt?.toISOString()??null,type:s.sourceType})),
    contactClaims:Array.isArray(venue.intelligence?.contactClaims)?venue.intelligence.contactClaims:[],
    reviews:venue.intelligenceReviews.map(r=>({id:r.id,kind:r.kind,status:r.status,reason:r.reason,original:r.original,revision:r.revision})),
    imports:imports.map(r=>({id:r.id,sourceWorkbookHash:r.sourceWorkbookHash,externalRecordId:r.externalRecordId,rawPayload:r.rawPayload,normalizedPayload:r.normalizedPayload,processingStatus:r.processingStatus})),
    audit:audit.map(r=>{
      if(r.venueId)return {...r,createdAt:r.createdAt.toISOString()}
      const onlyVenue=(value:unknown)=>Array.isArray(value)?value.filter(item=>object(item).venueId===venueId):[]
      const result=object(r.result),after=object(r.afterState)
      // A matched batch is evidence for this venue only. Never reveal its other
      // locations when an actor's current grant is narrower than the batch writer's.
      return {...r,createdAt:r.createdAt.toISOString(),beforeState:onlyVenue(r.beforeState),
        afterState:r.operation==='ranking-refresh'?onlyVenue(r.afterState):{schema:after.schema,jobs:onlyVenue(after.jobs)},
        result:r.operation==='ranking-refresh'?{rankingVersion:result.rankingVersion,asOf:result.asOf,venues:onlyVenue(result.venues),projection:'requested-venue-only'}:{schema:result.schema,jobs:onlyVenue(result.jobs),projection:'requested-venue-only'}}
    }),researchGaps:row.ranking.researchGaps }
}
export async function getChicagoHealth(scope:ChicagoScope):Promise<ChicagoHealth> {
  const venues = await market(scope), rows = venues.map(rowFor), venueIds=venues.map(v=>v.id)
  const [imports,reviews,jobs] = await Promise.all([
    db.prospectImport.findMany({where:{sourceRecords:{some:{canonicalVenueId:{in:venueIds}}}},orderBy:{createdAt:'desc'},take:30}),
    db.prospectIntelligenceReview.findMany({where:{status:'OPEN',OR:[{venueId:{in:venueIds}},...(scope.mode==='ALL'?[{venueId:null}]:[])]},orderBy:[{kind:'asc'},{id:'asc'}]}),
    db.prospectResearchJob.findMany({where:{organizationId:{in:[...new Set(venues.map(v=>v.organizationId))]}},orderBy:{updatedAt:'desc'},take:100}),
  ])
  const matrix = new Map<string,ChicagoHealth['matrix'][number]>()
  for(const row of rows){const key=[row.city,row.state,row.category].join('|');const entry=matrix.get(key)??{city:row.city??'Unknown',state:row.state??'Unknown',category:row.category??'Unknown',total:0,missingWebsite:0,missingContacts:0,needsResearch:0};entry.total++;if(!row.website)entry.missingWebsite++;if(row.contactability!=='verified')entry.missingContacts++;if(row.ranking.researchGaps.length)entry.needsResearch++;matrix.set(key,entry)}
  return {rankingVersion:CHICAGO_RANKING_VERSION,coverage:{...coverageFor(rows),quarantined:reviews.filter(r=>r.kind.includes('QUARANTINE')).length},
    imports:imports.map(i=>({id:i.id,sourceWorkbookHash:i.sourceWorkbookHash,status:i.status,totalRows:i.totalRows,importedRows:i.importedRows,failedRows:i.failedRows,createdAt:i.createdAt.toISOString(),reconciliation:i.reconciliation})),
    reviews:reviews.map(r=>({id:r.id,kind:r.kind,status:r.status,reason:r.reason,original:r.original,revision:r.revision})),
    jobs:jobs.map(j=>({id:j.id,organizationId:j.organizationId,status:j.status,claimOwnerId:j.claimOwnerId,claimExpiresAt:j.claimExpiresAt?.toISOString()??null,stuck:j.status==='CLAIMED'&&Boolean(j.claimExpiresAt&&j.claimExpiresAt<new Date())})),
    matrix:[...matrix.values()].sort((a,b)=>b.needsResearch-a.needsResearch||a.city.localeCompare(b.city)||a.category.localeCompare(b.category))}
}

export async function saveChicagoRanking(tx:Tx,venueId:string,input:ChicagoRankingInput) {
  const snapshot=rankChicagoVenue(input), inputHash=intelligenceHash(input)
  const id=`cvr_${intelligenceHash({venueId,version:snapshot.version,inputHash,asOf:input.asOf}).slice(0,32)}`
  if(!await tx.prospectVenueRanking.findUnique({where:{id}}))await tx.prospectVenueRanking.create({data:{id,venueId,version:snapshot.version,inputHash,asOf:input.asOf,input:intelligenceJson(input),snapshot:intelligenceJson(snapshot)}})
  return snapshot
}
function requireWriter(actor:ChicagoActor) {
  if(!actor.id||!actor.runId||!actor.capabilities.includes('prospects.maintain'))throw new ChicagoIntelligenceError('FORBIDDEN','Venue maintenance requires a separately granted capability and actor/run identity')
}
export async function intelligenceMutation<T extends {idempotencyKey:string}>(operation:string,input:T,actor:ChicagoActor,apply:(tx:Tx,receiptId:string)=>Promise<{venueId:string|null;before:unknown;after:unknown;result:Record<string,unknown>}>) {
  requireWriter(actor)
  const inputHash=intelligenceHash({operation,input}),id=`cvrx_${intelligenceHash({actor:actor.id,run:actor.runId,key:input.idempotencyKey}).slice(0,32)}`
  for(let attempt=0;attempt<3;attempt++){
    try{return await db.$transaction(async tx=>{
      const prior=await tx.prospectIntelligenceReceipt.findUnique({where:{id}})
      if(prior){
        if(prior.inputHash!==inputHash)throw new ChicagoIntelligenceError('CONFLICT','Idempotency key already belongs to a different payload; original receipt preserved')
        if(prior.venueId)await scopedVenue(prior.venueId,actor.scope,tx)
        return {receiptId:id,replayed:true,...object(prior.result)}
      }
      const changed=await apply(tx,id)
      await tx.prospectIntelligenceReceipt.create({data:{id,actorId:actor.id,actorType:actor.type,runId:actor.runId,idempotencyKey:input.idempotencyKey,operation,inputHash,venueId:changed.venueId,beforeState:intelligenceJson(changed.before),afterState:intelligenceJson(changed.after),result:intelligenceJson(changed.result)}})
      await tx.auditLog.create({data:{actorId:actor.id,actorType:actor.type,actorRole:actor.type==='AGENT'?'AGENT':'PLATFORM_ADMIN',...(actor.type==='AGENT'?{agentRunId:actor.runId}:{}),action:`prospect.intelligence.${operation}`,targetType:'ProspectVenue',targetId:changed.venueId??id,idempotencyKey:input.idempotencyKey,beforeState:intelligenceJson(changed.before),afterState:intelligenceJson(changed.after)}})
      return {receiptId:id,replayed:false,...changed.result}
    },{isolationLevel:'Serializable',timeout:20000,maxWait:10000})}
    catch(error){const code=object(error).code;if(code==='P2034'||code==='P2002'){if(attempt<2)continue;throw new ChicagoIntelligenceError('CONFLICT','Concurrent or duplicate identity change; original records preserved. Read current state and retry the exact request for receipt recovery.')}throw error}
  }
  throw new ChicagoIntelligenceError('CONFLICT','Concurrent update did not settle; retry the exact request')
}
export async function addChicagoVenue(raw:unknown,actor:ChicagoActor){
  const input=chicagoAddInput.parse(raw)
  if(actor.scope.mode==='TERRITORIES'&&!actor.scope.territoryIds.includes(input.territoryId))throw new ChicagoIntelligenceError('FORBIDDEN','Exact Chicago territory is outside the current grant')
  return intelligenceMutation('add',input,actor,async(tx,receiptId)=>{
    const territory=await tx.prospectTerritory.findFirst({where:{id:input.territoryId,name:'Chicago Metro',archivedAt:null}})
    if(!territory||(actor.scope.mode==='TERRITORIES'&&!actor.scope.territoryIds.includes(territory.id)))throw new ChicagoIntelligenceError('FORBIDDEN','Exact Chicago territory is outside the grant')
    const cityKnown=await tx.prospectVenue.findFirst({where:{territoryId:territory.id,city:{equals:input.city,mode:'insensitive'},region:input.state},select:{id:true}})
    if(!cityKnown){
      const reviewId=`cir_${receiptId}`
      await tx.prospectIntelligenceReview.create({data:{id:reviewId,kind:'TERRITORY_QUARANTINE',reason:'City is not yet evidenced in the established Chicago operating set; retain candidate for territory-owner review before admitting it.',original:intelligenceJson(input),createdBy:actor.id}})
      return {venueId:null,before:{},after:{reviewId,status:'quarantined'},result:{venueId:null,reviewId,quarantined:true,matched:false}}
    }
    const identityKey=normalizeChicagoIdentity(input.name,input.city,input.state)
    const current=await tx.prospectVenueIntelligence.findUnique({where:{identityKey},include:{venue:true}})
    if(current){await scopedVenue(current.venueId,actor.scope,tx);return {venueId:current.venueId,before:{revision:current.revision},after:{revision:current.revision},result:{venueId:current.venueId,organizationId:current.venue.organizationId,revision:current.revision,matched:true}}}
    const nativeMatches=await tx.prospectVenue.findMany({where:{name:{equals:input.name,mode:'insensitive'},city:{equals:input.city,mode:'insensitive'},region:input.state},select:{id:true}})
    if(nativeMatches.length)throw new ChicagoIntelligenceError('CONFLICT','Existing native identity needs reconciliation before adding another location')
    const geographyModel=await tx.prospectGeographyModel.findUnique({where:{version:PROSPECT_GEOGRAPHY_VERSION},select:{version:true}})
    if(geographyModel){
      const reviewId=`cir_${receiptId}`
      await tx.prospectIntelligenceReview.create({data:{id:reviewId,kind:'PHYSICAL_GEOGRAPHY_REQUIRED',reason:'The county registry is installed. This legacy city-only discovery input cannot establish physical-county ownership or safely admit a new canonical venue. Retain evidence for centralized identity and geography review.',original:intelligenceJson({input,modelVersion:geographyModel.version,canonicalVenueCreated:false}),createdBy:actor.id}})
      return {venueId:null,before:{},after:{reviewId,status:'quarantined'},result:{venueId:null,reviewId,quarantined:true,matched:false,reason:'physical-county-evidence-required'}}
    }
    const venueId=`cv_${intelligenceHash(identityKey).slice(0,32)}`,organizationId=`co_${intelligenceHash(identityKey).slice(0,32)}`
    const domain=new URL(input.website).hostname.replace(/^www\./,'')
    const identities=await tx.prospectVenue.findMany({where:{territoryId:territory.id},select:{id:true,name:true,organizationId:true,normalizedDomain:true,normalizedName:true,website:true}})
    const possible=identities.filter(candidate=>(candidate.normalizedDomain??chicagoWebsiteDomain(candidate.website))===domain||candidate.normalizedName===normalizeChicagoIdentity(input.name,'','').split('|')[0]!).map(({id,name,organizationId})=>({id,name,organizationId}))
    await tx.prospectOrganization.create({data:{id:organizationId,canonicalName:input.name,normalizedName:normalizeChicagoIdentity(input.name,'','').split('|')[0]!,website:input.website,normalizedDomain:domain,territoryId:territory.id,source:'CHICAGO_VENUE_INTELLIGENCE',createdBy:actor.id,updatedBy:actor.id}})
    await tx.prospectVenue.create({data:{id:venueId,organizationId,territoryId:territory.id,name:input.name,normalizedName:normalizeChicagoIdentity(input.name,'','').split('|')[0]!,city:input.city,region:input.state,venueType:input.category??null,website:input.website,normalizedDomain:domain,createdBy:actor.id,updatedBy:actor.id}})
    await tx.prospectOpportunity.create({data:{organizationId,source:'CHICAGO_VENUE_INTELLIGENCE',createdBy:actor.id,updatedBy:actor.id}})
    const evidenceId=`cve_${receiptId}`
    await tx.prospectSourceEvidence.create({data:{id:evidenceId,organizationId,venueId,sourceType:'FIRST_PARTY_AGENT_OBSERVATION',sourceUrl:input.evidence.url,sourceLabel:input.evidence.statement,researchedAt:new Date(input.evidence.researchedAt),capturedValue:intelligenceJson({evidence:input.evidence,territoryRationale:input.territoryRationale}),createdBy:actor.id}})
    const rankingInput:ChicagoRankingInput={venueId,asOf:dateOnly(),territory:'Chicago Metro',venueType:input.category??null,sources:[{url:input.evidence.url,firstParty:true,researchedAt:input.evidence.researchedAt}],fields:{name:true,city:true,state:true,category:Boolean(input.category),website:true,fit:false,attainability:false,contact:false}}
    const snapshot=await saveChicagoRanking(tx,venueId,rankingInput)
    const fields=Object.fromEntries(Object.entries({name:input.name,city:input.city,region:input.state,website:input.website,venueType:input.category??null}).map(([key,value])=>[key,{value,status:value?'verified':'unknown',sourceUrls:value?[input.evidence.url]:[],researchedAt:value?input.evidence.researchedAt:null,actor:actor.id}]))
    await tx.prospectVenueIntelligence.create({data:{venueId,identityKey,fields:intelligenceJson(fields),rankingInput:intelligenceJson(rankingInput),rankingSnapshot:intelligenceJson(snapshot),rankingVersion:snapshot.version}})
    for(const candidate of possible)await tx.prospectIntelligenceReview.create({data:{id:`cir_${intelligenceHash([venueId,candidate.id]).slice(0,32)}`,venueId,kind:'IDENTITY_REVIEW',reason:'Similar name or shared domain; keep distinct pending evidence, never automatically merge.',original:intelligenceJson({candidate,...input}),createdBy:actor.id}})
    return {venueId,before:{},after:{venueId,organizationId,revision:1},result:{venueId,organizationId,revision:1,matched:false,duplicateSignals:possible}}
  })
}
export async function changeChicagoVenue(raw:unknown,actor:ChicagoActor){
  const input=chicagoChangeInput.parse(raw)
  if(input.field==='website'){const u=new URL(input.value);if(!['http:','https:'].includes(u.protocol))throw new ChicagoIntelligenceError('INVALID_INPUT','Website requires HTTP URL')}
  if(input.field==='region'&&!['IL','IN','WI'].includes(input.value))throw new ChicagoIntelligenceError('INVALID_INPUT','Chicago operating region is IL, IN, WI')
  return intelligenceMutation('change',input,actor,async(tx,receiptId)=>{
    const venue=await scopedVenue(input.venueId,actor.scope,tx),profile=venue.intelligence
    if(!profile||profile.revision!==input.expectedVersion)throw new ChicagoIntelligenceError('CONFLICT',`Venue changed; current revision ${profile?.revision??0}. Read it before proposing another change.`)
    const updated=await tx.prospectVenueIntelligence.updateMany({where:{venueId:venue.id,revision:input.expectedVersion},data:{revision:{increment:1}}})
    if(updated.count!==1)throw new ChicagoIntelligenceError('CONFLICT','Concurrent venue edit; original value preserved')
    const before={revision:profile.revision,fields:profile.fields},revision=profile.revision+1
    if(input.mode==='apply'&&['city','region'].includes(input.field)){
      const city=input.field==='city'?input.value:venue.city,state=input.field==='region'?input.value:venue.region
      const admitted=await tx.prospectVenue.findFirst({where:{territoryId:venue.territoryId,city,region:state},select:{id:true}})
      if(!admitted)throw new ChicagoIntelligenceError('CONFLICT','Location change needs territory review; propose the field instead')
    }
    const evidenceId=`cve_${receiptId}`
    await tx.prospectSourceEvidence.create({data:{id:evidenceId,organizationId:venue.organizationId,venueId:venue.id,sourceType:input.mode==='apply'?'FIRST_PARTY_AGENT_OBSERVATION':'PROPOSED_FIELD_EVIDENCE',sourceUrl:input.evidence.url,sourceLabel:input.evidence.statement,researchedAt:new Date(input.evidence.researchedAt),capturedValue:intelligenceJson(input),createdBy:actor.id}})
    if(input.mode==='propose'){
      const reviewId=`cir_${receiptId}`
      await tx.prospectIntelligenceReview.create({data:{id:reviewId,venueId:venue.id,kind:'FIELD_PROPOSAL',reason:input.evidence.statement,original:intelligenceJson({input,before}),createdBy:actor.id}})
      return {venueId:venue.id,before,after:{revision,reviewId},result:{venueId:venue.id,revision,reviewId,applied:false}}
    }
    const fields={...object(profile.fields),[input.field]:{value:input.value,status:'verified',sourceUrls:[input.evidence.url],researchedAt:input.evidence.researchedAt,actor:actor.id}}
    const currentInput=object(profile.rankingInput) as unknown as ChicagoRankingInput
    const completenessKey=input.field==='venueType'?'category':input.field==='region'?'state':input.field
    const rankingInput:ChicagoRankingInput={...currentInput,venueId:venue.id,territory:'Chicago Metro',asOf:dateOnly(),venueType:input.field==='venueType'?input.value:venue.venueType,sources:[...(currentInput.sources??[]),{url:input.evidence.url,firstParty:true,researchedAt:input.evidence.researchedAt}],fields:{...currentInput.fields,[completenessKey]:true}}
    const snapshot=await saveChicagoRanking(tx,venue.id,rankingInput)
    const name=input.field==='name'?input.value:venue.name,city=input.field==='city'?input.value:venue.city??'',state=input.field==='region'?input.value:venue.region??''
    await tx.prospectVenueIntelligence.update({where:{venueId:venue.id},data:{fields:intelligenceJson(fields),identityKey:normalizeChicagoIdentity(name,city,state),rankingInput:intelligenceJson(rankingInput),rankingSnapshot:intelligenceJson(snapshot),rankingVersion:snapshot.version}})
    // Organization descriptions are separate from location observations; retain venue description in field provenance.
    if(input.field!=='description')await tx.prospectVenue.update({where:{id:venue.id},data:{[input.field]:input.value,...(input.field==='name'?{normalizedName:normalizeChicagoIdentity(input.value,'','').split('|')[0]}:{}),...(input.field==='website'?{normalizedDomain:new URL(input.value).hostname.replace(/^www\./,'')}:{}),updatedBy:actor.id}})
    return {venueId:venue.id,before,after:{revision,fields},result:{venueId:venue.id,revision,evidenceId,applied:true}}
  })
}
export async function proposeChicagoDuplicate(raw:unknown,actor:ChicagoActor){
  const input=chicagoDuplicateInput.parse(raw)
  if(input.venueId===input.otherVenueId)throw new ChicagoIntelligenceError('INVALID_INPUT','Choose two distinct venues')
  await scopedVenue(input.venueId,actor.scope)
  await scopedVenue(input.otherVenueId,actor.scope)
  return intelligenceMutation('relationship',input,actor,async(tx,receiptId)=>{
    const venue=await scopedVenue(input.venueId,actor.scope,tx);await scopedVenue(input.otherVenueId,actor.scope,tx)
    const revision=venue.intelligence?.revision??0
    if(revision!==input.expectedVersion)throw new ChicagoIntelligenceError('CONFLICT',`Venue changed; current revision ${revision}`)
    const reviewId=`cir_${receiptId}`
    await tx.prospectIntelligenceReview.create({data:{id:reviewId,venueId:venue.id,kind:input.relation==='same-operator'?'SAME_OPERATOR':'POSSIBLE_DUPLICATE',reason:input.reason,original:intelligenceJson(input),createdBy:actor.id}})
    const changed=await tx.prospectVenueIntelligence.updateMany({where:{venueId:venue.id,revision},data:{revision:{increment:1}}})
    if(changed.count!==1)throw new ChicagoIntelligenceError('CONFLICT','Concurrent change; re-read both venues')
    return {venueId:venue.id,before:{revision},after:{revision:revision+1,reviewId},result:{venueId:venue.id,revision:revision+1,reviewId,merged:false}}
  })
}
export async function resolveChicagoReview(raw:unknown,actor:ChicagoActor){
  const input=chicagoReviewInput.parse(raw)
  if(actor.type!=='HUMAN')throw new ChicagoIntelligenceError('FORBIDDEN','Review resolution is an operator action; agents may propose relationships')
  const scopedReview=await db.prospectIntelligenceReview.findUnique({where:{id:input.reviewId}})
  if(!scopedReview)throw new ChicagoIntelligenceError('NOT_FOUND','Review not found')
  if(scopedReview.venueId)await scopedVenue(scopedReview.venueId,actor.scope)
  else if(actor.scope.mode!=='ALL')throw new ChicagoIntelligenceError('FORBIDDEN','Unmapped source review needs operator-wide scope')
  return intelligenceMutation('review',input,actor,async tx=>{
    const review=await tx.prospectIntelligenceReview.findUnique({where:{id:input.reviewId}})
    if(!review)throw new ChicagoIntelligenceError('NOT_FOUND','Review not found')
    if(review.venueId)await scopedVenue(review.venueId,actor.scope,tx)
    else if(actor.scope.mode!=='ALL')throw new ChicagoIntelligenceError('FORBIDDEN','Unmapped source review needs operator-wide scope')
    const changed=await tx.prospectIntelligenceReview.updateMany({where:{id:review.id,revision:input.expectedVersion},data:{revision:{increment:1},status:'RESOLVED',decision:intelligenceJson({decision:input.decision,rationale:input.rationale,actor:actor.id,at:new Date().toISOString()})}})
    if(changed.count!==1)throw new ChicagoIntelligenceError('CONFLICT','Review changed; reload its current decision')
    return {venueId:review.venueId,before:{status:review.status,revision:review.revision},after:{status:'RESOLVED',revision:review.revision+1,decision:input.decision},result:{reviewId:review.id,revision:review.revision+1}}
  })
}

export async function appendChicagoEvidence(raw:unknown,actor:ChicagoActor){
  const input=chicagoAppendEvidenceInput.parse(raw)
  return intelligenceMutation('append-evidence',input,actor,async(tx,receiptId)=>{
    const venue=await scopedVenue(input.venueId,actor.scope,tx),profile=venue.intelligence
    if(!profile||profile.revision!==input.expectedVersion)throw new ChicagoIntelligenceError('CONFLICT',`Venue changed; current revision ${profile?.revision??0}`)
    const advanced=await tx.prospectVenueIntelligence.updateMany({where:{venueId:venue.id,revision:input.expectedVersion},data:{revision:{increment:1}}})
    if(advanced.count!==1)throw new ChicagoIntelligenceError('CONFLICT','Concurrent evidence update; reload the current venue')
    const stored=object(profile.rankingInput) as unknown as ChicagoRankingInput
    const observation=input.observation,evidence=input.evidence
    const rankingInput:ChicagoRankingInput={...stored,venueId:venue.id,territory:'Chicago Metro',asOf:dateOnly(),venueType:venue.venueType,sources:[...(stored.sources??[]),{url:evidence.url,firstParty:true,researchedAt:evidence.researchedAt}]}
    const valueObservation=observation.kind==='fit'||observation.kind==='attainability'?{value:observation.value,reason:observation.reason,sourceUrls:[evidence.url],researchedAt:evidence.researchedAt,basis:'verified' as const}:null
    if(observation.kind==='fit'&&valueObservation)rankingInput.fit={...stored.fit,[observation.key]:valueObservation}
    if(observation.kind==='attainability'&&valueObservation)rankingInput.attainability={...stored.attainability,[observation.key]:valueObservation}
    const claims:unknown[]=Array.isArray(profile.contactClaims)?[...profile.contactClaims]:[]
    if(observation.kind==='contact'){
      const suppressed=venue.contacts.some(c=>!c.archivedAt&&(c.doNotContact||c.suppressedAt||c.unsubscribedAt||['OPTED_OUT','PROHIBITED'].includes(c.permissionState)))
      // Native suppression is live policy, not a permanent property of this
      // published routing observation. Read and snapshot scoring apply it separately.
      rankingInput.contacts=[...(stored.contacts??[]),{kind:observation.channel,verified:true,suppressed:false,roleRelevant:observation.roleRelevant,sourceUrls:[evidence.url],researchedAt:evidence.researchedAt}]
      claims.push(intelligenceJson({channel:observation.channel,value:observation.value,status:suppressed?'suppressed':'verified-public-claim',roleRelevant:observation.roleRelevant,sourceUrls:[evidence.url],researchedAt:evidence.researchedAt,actor:actor.id,permission:'Unknown; a public contact is not sending permission'}))
    }
    const fitComplete=Object.values(rankingInput.fit??{}).filter(Boolean).length===6,attainableComplete=Object.values(rankingInput.attainability??{}).filter(Boolean).length===5
    rankingInput.fields={...stored.fields,fit:fitComplete,attainability:attainableComplete,verifiedContact:(rankingInput.contacts??[]).some(c=>c.verified&&!c.suppressed)}
    const nativeSuppressed=venue.contacts.some(c=>!c.archivedAt&&(c.doNotContact||c.suppressedAt||c.unsubscribedAt||['OPTED_OUT','PROHIBITED'].includes(c.permissionState)))
    const snapshot=await saveChicagoRanking(tx,venue.id,{...rankingInput,archived:Boolean(venue.archivedAt||venue.organization.archivedAt),contacts:(rankingInput.contacts??[]).map(c=>({...c,suppressed:c.suppressed||nativeSuppressed}))}),evidenceId=`cve_${receiptId}`
    await tx.prospectSourceEvidence.create({data:{id:evidenceId,venueId:venue.id,organizationId:venue.organizationId,sourceType:'FIRST_PARTY_AGENT_OBSERVATION',sourceUrl:evidence.url,sourceLabel:evidence.statement,researchedAt:new Date(evidence.researchedAt),capturedValue:intelligenceJson({observation,evidence,actor:actor.id,runId:actor.runId}),createdBy:actor.id}})
    await tx.prospectVenueIntelligence.update({where:{venueId:venue.id},data:{rankingInput:intelligenceJson(rankingInput),rankingSnapshot:intelligenceJson(snapshot),rankingVersion:snapshot.version,contactClaims:intelligenceJson(claims)}})
    return {venueId:venue.id,before:{revision:profile.revision,rankingInput:profile.rankingInput},after:{revision:profile.revision+1,rankingInput},result:{venueId:venue.id,revision:profile.revision+1,evidenceId}}
  })
}
