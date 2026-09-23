import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library'
import { db } from '../client'
import { ClaimCountyResearchInput, RenewCountyResearchInput, ReleaseCountyResearchInput, CompleteCountyResearchInput, ReadCountyResearchInput } from './prospect-county-research-contract'
import { PROSPECT_GEOGRAPHY_HASH, PROSPECT_GEOGRAPHY_VERSION, geographyHash, countyResearchOwner } from './prospect-territory-registry'
import { ProspectGeographyError, type GeographyActor } from './prospect-territory-actions'

/** Supplied only by a trusted transport. Never accepted from a request body. */
export type CountyResearchActor = GeographyActor & { authorityContext:string }
export type CountyResearchTransaction = Pick<typeof db,
  'prospectGeographyModel'|'prospectTerritory'|'prospectTerritoryDefinition'|'prospectCountyAssignment'|'prospectCountyResearchLease'|
  'prospectIntelligenceReceipt'|'prospectIntelligenceReview'|'prospectVenue'|
  'prospectOrganization'|'prospectSourceEvidence'|'prospectVenueGeography'|
  'prospectResearchJob'|'prospectResearchAttempt'|'auditLog'>
export const countyJson=(value:unknown):Prisma.InputJsonValue=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
export const countyObject=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
export const countyConflict=(message:string):never=>{throw new ProspectGeographyError('CONFLICT',message)}
export function requireCountyActor(actor:CountyResearchActor,capability:string){
  if(!actor.id.trim()||!actor.runId.trim()||!actor.authorityContext.trim()||actor.authorityContext.length>400||!actor.capabilities.includes(capability))
    throw new ProspectGeographyError('FORBIDDEN',`Verified actor/run/authority context requires ${capability}`)
}
export function requireCountyScope(actor:CountyResearchActor,territoryId:string|null){
  if(actor.scope.mode!=='ALL'&&(!territoryId||!actor.scope.territoryIds.includes(territoryId)))
    throw new ProspectGeographyError('FORBIDDEN','Pinned county owner is outside the current exact territory grant')
}
export async function verifiedCounty(tx:CountyResearchTransaction,countyGeoid:string,actor:CountyResearchActor){
  const pinned=countyResearchOwner(countyGeoid)
  if(!pinned)throw new ProspectGeographyError('BAD_REQUEST','County is not in the pinned contiguous-US model')
  const model=await tx.prospectGeographyModel.findUnique({where:{version:PROSPECT_GEOGRAPHY_VERSION}})
  if(!model||model.registryHash!==PROSPECT_GEOGRAPHY_HASH)countyConflict('Installed county model does not match this release')
  const county=await tx.prospectCountyAssignment.findUnique({where:{modelVersion_countyGeoid:{modelVersion:PROSPECT_GEOGRAPHY_VERSION,countyGeoid}}})
  if(!county||county.territoryCode!==pinned.territoryCode)countyConflict('Pinned county bridge is absent or inconsistent')
  requireCountyScope(actor,county!.territoryId)
  return county!
}
export async function countyTransaction<T>(work:(tx:CountyResearchTransaction)=>Promise<T>):Promise<T>{
  // SERIALIZABLE also protects global identity predicate reads from concurrent
  // native admission or quarantine. A retry reruns those reads, not just writes.
  for(let attempt=0;attempt<5;attempt++){
    try{return await db.$transaction(work,{isolationLevel:'Serializable',maxWait:10000,timeout:30000})}
    catch(error){
      if(error instanceof PrismaClientKnownRequestError&&['P2034','P2002'].includes(error.code)&&attempt<4)continue
      throw error
    }
  }
  return countyConflict('Concurrent county operation; retry the identical request key')
}
export const countyReceiptId=(actor:CountyResearchActor,key:string)=>`county_rx_${geographyHash({actor:actor.id,run:actor.runId,key}).slice(0,40)}`
export async function recoverCountyReceipt(tx:CountyResearchTransaction,actor:CountyResearchActor,operation:string,input:{idempotencyKey:string}){
  const previous=await tx.prospectIntelligenceReceipt.findUnique({where:{actorId_runId_idempotencyKey:{actorId:actor.id,runId:actor.runId,idempotencyKey:input.idempotencyKey}}})
  if(!previous)return null
  if(previous.operation!==operation||previous.inputHash!==geographyHash({operation,input,authorityContext:actor.authorityContext}))
    countyConflict('This retry key belongs to a different input, operation or verified authority context')
  return {...countyObject(previous.result),receiptId:previous.id,replayed:true}
}
export async function saveCountyReceipt(tx:CountyResearchTransaction,actor:CountyResearchActor,operation:string,input:{idempotencyKey:string},before:unknown,result:Record<string,unknown>){
  const id=countyReceiptId(actor,input.idempotencyKey)
  await tx.prospectIntelligenceReceipt.create({data:{id,actorId:actor.id,actorType:actor.type,runId:actor.runId,idempotencyKey:input.idempotencyKey,
    operation,inputHash:geographyHash({operation,input,authorityContext:actor.authorityContext}),venueId:null,
    beforeState:countyJson(before),afterState:countyJson(result),result:countyJson(result)}})
  await tx.auditLog.create({data:{actorId:actor.id,actorType:actor.type,actorRole:actor.type==='AGENT'?'AGENT':'PLATFORM_ADMIN',
    ...(actor.type==='AGENT'?{agentRunId:actor.runId}:{}),action:`prospect.${operation}`,targetType:'ProspectCountyResearch',
    targetId:String(result.countyGeoid??result.reviewId??PROSPECT_GEOGRAPHY_VERSION),beforeState:countyJson(before),afterState:countyJson(result)}})
  return {...result,receiptId:id,replayed:false}
}
type Binding={countyGeoid:string;claimToken:string;generation:number}
const leaseKey=(countyGeoid:string)=>({modelVersion_countyGeoid:{modelVersion:PROSPECT_GEOGRAPHY_VERSION,countyGeoid}})
export async function ownedCountyLease(tx:CountyResearchTransaction,input:Binding,actor:CountyResearchActor){
  await verifiedCounty(tx,input.countyGeoid,actor)
  const row=await tx.prospectCountyResearchLease.findUnique({where:leaseKey(input.countyGeoid)})
  if(!row||row.status!=='LEASED'||row.generation!==input.generation||row.claimToken!==input.claimToken||row.actorId!==actor.id||
    row.actorRunId!==actor.runId||row.authorityContext!==actor.authorityContext||row.leaseExpiresAt<=new Date())
    return countyConflict('County lease is expired, replaced, released or belongs to another verified actor/run')
  return row
}
export async function fenceCountyLease(tx:CountyResearchTransaction,input:Binding,actor:CountyResearchActor,data:Prisma.ProspectCountyResearchLeaseUpdateManyMutationInput={}){
  const now=new Date()
  const changed=await tx.prospectCountyResearchLease.updateMany({where:{modelVersion:PROSPECT_GEOGRAPHY_VERSION,countyGeoid:input.countyGeoid,
    generation:input.generation,claimToken:input.claimToken,status:'LEASED',actorId:actor.id,actorRunId:actor.runId,
    authorityContext:actor.authorityContext,leaseExpiresAt:{gt:now}},data:{...data,updatedAt:now}})
  if(changed.count!==1)countyConflict('County lease expired or changed before commit; no partial research result was admitted')
}
async function claimReplay(tx:CountyResearchTransaction,actor:CountyResearchActor,countyGeoid:string,result:Record<string,unknown>){
  const live=await tx.prospectCountyResearchLease.findUnique({where:leaseKey(countyGeoid)})
  return {...result,leaseUsableNow:Boolean(live&&live.status==='LEASED'&&live.actorId===actor.id&&live.actorRunId===actor.runId&&
    live.authorityContext===actor.authorityContext&&live.generation===result.generation&&live.claimToken===result.claimToken&&live.leaseExpiresAt>new Date()),
    replayWarning:'A recovered receipt is historical. Its lease must still be current and unexpired before doing any work.'}
}

export async function claimCountyResearch(raw:unknown,actor:CountyResearchActor){
  requireCountyActor(actor,'prospects.research')
  const input=ClaimCountyResearchInput.parse(raw),operation='county-research-claim'
  return countyTransaction(async tx=>{
    const county=await verifiedCounty(tx,input.countyGeoid,actor)
    const recovered=await recoverCountyReceipt(tx,actor,operation,input)
    if(recovered)return claimReplay(tx,actor,input.countyGeoid,recovered)
    const previous=await tx.prospectCountyResearchLease.findUnique({where:leaseKey(input.countyGeoid)}),now=new Date()
    if(previous?.status==='LEASED'&&previous.leaseExpiresAt>now)countyConflict('This whole county is already leased. No overlapping work scope was acquired.')
    const generation=(previous?.generation??0)+1,claimToken=randomUUID(),leaseExpiresAt=new Date(now.getTime()+input.leaseSeconds*1000)
    const values={territoryId:county.territoryId,generation,claimToken,actorId:actor.id,actorRunId:actor.runId,authorityContext:actor.authorityContext,
      status:'LEASED',claimedAt:now,leaseExpiresAt,plannedCells:countyJson(input.plannedCells),outcome:countyJson({status:'NOT_REPORTED',exhaustive:false})}
    if(previous){
      const updated=await tx.prospectCountyResearchLease.updateMany({where:{modelVersion:PROSPECT_GEOGRAPHY_VERSION,countyGeoid:input.countyGeoid,generation:previous.generation,
        OR:[{status:{not:'LEASED'}},{leaseExpiresAt:{lte:now}}]},data:values})
      if(updated.count!==1)countyConflict('A concurrent worker acquired this county')
    }else await tx.prospectCountyResearchLease.create({data:{modelVersion:PROSPECT_GEOGRAPHY_VERSION,countyGeoid:input.countyGeoid,...values}})
    return saveCountyReceipt(tx,actor,operation,input,{priorLease:previous,priorAttemptState:previous?.status==='LEASED'?'EXPIRED_WITHOUT_COMPLETION':previous?.status??'NONE'},
      {countyGeoid:input.countyGeoid,territoryId:county.territoryId,territoryCode:county.territoryCode,modelVersion:PROSPECT_GEOGRAPHY_VERSION,
        scopeKind:'WHOLE_COUNTY',generation,claimToken,leaseExpiresAt:leaseExpiresAt.toISOString(),plannedCells:input.plannedCells,
        leaseUsableNow:true,exhaustive:false,outreachAuthorized:false})
  })
}
export async function renewCountyResearch(raw:unknown,actor:CountyResearchActor){
  requireCountyActor(actor,'prospects.research')
  const input=RenewCountyResearchInput.parse(raw),operation='county-research-renew'
  return countyTransaction(async tx=>{
    await verifiedCounty(tx,input.countyGeoid,actor)
    const recovered=await recoverCountyReceipt(tx,actor,operation,input)
    if(recovered)return claimReplay(tx,actor,input.countyGeoid,recovered)
    const before=await ownedCountyLease(tx,input,actor),leaseExpiresAt=new Date(Date.now()+input.leaseSeconds*1000)
    await fenceCountyLease(tx,input,actor,{leaseExpiresAt})
    return saveCountyReceipt(tx,actor,operation,input,{generation:before.generation,leaseExpiresAt:before.leaseExpiresAt},
      {countyGeoid:input.countyGeoid,generation:input.generation,claimToken:input.claimToken,leaseExpiresAt:leaseExpiresAt.toISOString(),leaseUsableNow:true,outreachAuthorized:false})
  })
}
export async function releaseCountyResearch(raw:unknown,actor:CountyResearchActor){
  requireCountyActor(actor,'prospects.research')
  const input=ReleaseCountyResearchInput.parse(raw),operation='county-research-release'
  return countyTransaction(async tx=>{
    await verifiedCounty(tx,input.countyGeoid,actor)
    const recovered=await recoverCountyReceipt(tx,actor,operation,input);if(recovered)return recovered
    const before=await ownedCountyLease(tx,input,actor)
    const outcome={status:'RELEASED_INCOMPLETE',reason:input.reason,exhaustive:false}
    await fenceCountyLease(tx,input,actor,{status:'RELEASED',outcome:countyJson(outcome)})
    return saveCountyReceipt(tx,actor,operation,input,{generation:before.generation,plannedCells:before.plannedCells},
      {countyGeoid:input.countyGeoid,generation:input.generation,...outcome,outreachAuthorized:false})
  })
}
export async function completeCountyResearch(raw:unknown,actor:CountyResearchActor){
  requireCountyActor(actor,'prospects.research')
  const input=CompleteCountyResearchInput.parse(raw),operation='county-research-complete'
  return countyTransaction(async tx=>{
    await verifiedCounty(tx,input.countyGeoid,actor)
    const recovered=await recoverCountyReceipt(tx,actor,operation,input);if(recovered)return recovered
    const before=await ownedCountyLease(tx,input,actor),plan=ClaimCountyResearchInput.shape.plannedCells.parse(before.plannedCells)
    if(new Set(input.cells.map(cell=>cell.id)).size!==input.cells.length||input.cells.some(cell=>!plan.some(p=>p.id===cell.id)))
      throw new ProspectGeographyError('BAD_REQUEST','Coverage must use unique cells from the exact acquired plan')
    for(const cell of input.cells){
      if(cell.status.startsWith('SEARCHED')&&!cell.sourceUrls.length&&!cell.queries.length)
        throw new ProspectGeographyError('BAD_REQUEST','Searched cells require actual attempted source URLs or recorded queries')
      if(cell.status==='SEARCHED_NO_RESULTS'&&cell.findingReceiptIds.length)
        throw new ProspectGeographyError('BAD_REQUEST','A zero-result cell cannot simultaneously claim finding receipts')
      if(cell.status==='SEARCHED_WITH_RESULTS'&&!cell.findingReceiptIds.length)
        throw new ProspectGeographyError('BAD_REQUEST','Claimed findings require durable discovery receipts')
      for(const id of cell.findingReceiptIds){
        const receipt=await tx.prospectIntelligenceReceipt.findUnique({where:{id}}),result=countyObject(receipt?.result)
        if(!receipt||receipt.operation!=='county-discovery-submit'||receipt.actorId!==actor.id||receipt.runId!==actor.runId||
          result.generation!==input.generation||result.claimedCountyGeoid!==input.countyGeoid||result.cellId!==cell.id)
          throw new ProspectGeographyError('BAD_REQUEST','Finding receipt is not part of this exact county attempt and cell')
      }
    }
    const cells=plan.map(p=>input.cells.find(c=>c.id===p.id)??{id:p.id,status:'NOT_ATTEMPTED',sourceUrls:[],queries:[],findingReceiptIds:[],note:'No attempt was reported for this planned cell.'})
    const outcome={status:'ATTEMPT_RECORDED',summary:input.summary,cells,plannedCells:plan.length,
      searchedCells:cells.filter(c=>c.status.startsWith('SEARCHED')).length,partialCells:cells.filter(c=>c.status==='PARTIAL').length,
      unattemptedCells:cells.filter(c=>c.status==='NOT_ATTEMPTED').length,exhaustive:false,
      meaning:'Only the recorded attempts are covered. This does not certify exhaustive county research.'}
    await fenceCountyLease(tx,input,actor,{status:'ATTEMPT_RECORDED',outcome:countyJson(outcome)})
    return saveCountyReceipt(tx,actor,operation,input,{generation:before.generation,plannedCells:before.plannedCells},
      {countyGeoid:input.countyGeoid,generation:input.generation,...outcome,outreachAuthorized:false})
  })
}
export async function readCountyResearch(raw:unknown,actor:CountyResearchActor){
  requireCountyActor(actor,'prospects.read')
  const input=ReadCountyResearchInput.parse(raw)
  const where={modelVersion:PROSPECT_GEOGRAPHY_VERSION,...(input.countyGeoid?{countyGeoid:input.countyGeoid}:{}),
    ...(actor.scope.mode==='ALL'?{}:{territoryId:{in:[...actor.scope.territoryIds]}})}
  const [total,rows]=await Promise.all([db.prospectCountyResearchLease.count({where}),db.prospectCountyResearchLease.findMany({where,
    orderBy:{countyGeoid:'asc'},skip:(input.page-1)*input.limit,take:input.limit,include:{county:{select:{countyName:true,territoryCode:true,state:true}}}})])
  return {modelVersion:PROSPECT_GEOGRAPHY_VERSION,total,page:input.page,limit:input.limit,hasMore:input.page*input.limit<total,
    items:rows.map(({claimToken,authorityContext,...row})=>({...row,
      expired:row.status==='LEASED'&&row.leaseExpiresAt<=new Date(),
      ...(row.actorId===actor.id&&row.actorRunId===actor.runId&&authorityContext===actor.authorityContext?{claimToken}:{}),
      exhaustive:false})),subcountyClaimsAvailable:false,outreachAuthorized:false}
}
