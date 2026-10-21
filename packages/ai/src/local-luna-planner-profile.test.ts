import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText } from './anthropic'
import { generateTextForCapability } from './routed-generation'
import { setOpenAiResponsesClientForTesting, createOpenAiTextStream } from './openai-text'
import { getAiModelSpec } from './model-registry'
import { textAttemptCostCeilingUnits, withAiRequestBudgetCeiling, type AiBudgetGate } from './budget'
import { LocalLunaPlannerExecutionError, type LocalLunaPlannerProfile } from './local-luna-planner-profile'
import type { AiRoutePlan } from './capability-routing'
const system=[{type:'text' as const,text:'Interpret stored selection only.'}]
const messages=[{role:'user' as const,content:'Count shops.'}]
const spec=getAiModelSpec('guest-chat-luna-reasoning')
const usage={input_tokens:130,output_tokens:40,total_tokens:170,input_tokens_details:{cached_tokens:30,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:10}}
const response=(tier:unknown='fast')=>({model:'gpt-6-luna',id:'resp_synthetic_profile',status:'completed',service_tier:tier,output_text:'{"status":"QUERY"}',usage})
const gate=()=>({reserve:vi.fn(async(attempt)=>({id:'hold',reservedUnits:attempt.reservedUnits})),markDispatched:vi.fn(async()=>{}),settleExact:vi.fn(async()=>{}),settleAmbiguous:vi.fn(async()=>{}),releaseUndispatched:vi.fn(async()=>{})}) satisfies AiBudgetGate
function setup(tier:unknown='fast'){
 const create=vi.fn().mockResolvedValue(response(tier));setOpenAiResponsesClientForTesting({responses:{create}})
 const budget=gate(),sink=vi.fn(async()=>{})
 const params={modelKey:'guest-chat-luna-reasoning' as const,invocationProfile:'LOCAL_LUNA_FAST_V1' as LocalLunaPlannerProfile,system,messages,maxAttempts:1,maxOutputTokens:1024,budgetGate:budget,usageSink:sink,admissionGuard:vi.fn(async()=>{}),invocationId:'synthetic-invocation'}
 return {create,budget,sink,params}
}
const route:AiRoutePlan={capability:'STANDARD',workloadId:'guest-chat',configurationVersion:'synthetic-route',latencyPreference:'BALANCED',qualityPreference:'BALANCED',candidates:[{provider:'openai',model:'gpt-6-luna',modelKey:'guest-chat-luna-reasoning',costTier:'ECONOMY',fallback:false}]}
afterEach(()=>setOpenAiResponsesClientForTesting(null))
describe('explicit local Luna planner execution profiles',()=>{
 it.each(['fast','priority','default'])('settles observed %s with exact SDK receipt and same observed cost in result and usage',async tier=>{
  const {params,create,budget,sink}=setup(tier);const result=await generateText(params)
  const units=tier==='default'?3030n:6060n
  expect(budget.settleExact).toHaveBeenCalledWith(expect.anything(),units)
  expect(result.estimatedCostUsd).toBeCloseTo(Number(units)/1e8,12)
  expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({estimatedCostUsd:result.estimatedCostUsd,providerResponseId:'resp_synthetic_profile',costObservationStatus:'OBSERVED',serviceTier:result.serviceTier,pricingVersion:result.pricingVersion}))
  const bytes=Buffer.from(JSON.stringify(create.mock.calls[0]![0]))
  expect(result.serviceTier).toMatchObject({profile:'LOCAL_LUNA_FAST_V1',requestedTier:'fast',observedTier:tier,providerResponseId:'resp_synthetic_profile',sdkRequestSha256:createHash('sha256').update(bytes).digest('hex'),sdkRequestUtf8Bytes:bytes.length,wireBoundary:'SDK_PARAMS_JSON_NOT_OBSERVED_HTTP',outcome:tier==='default'?'STANDARD_DOWNGRADE':'FAST_SERVED'})
  expect(create.mock.calls[0]![0]).toMatchObject({service_tier:'fast',max_output_tokens:1024,reasoning:{effort:'low'}})
  expect(create.mock.calls[0]![0]).not.toHaveProperty('stream');expect(create).toHaveBeenCalledOnce()
 })
 it('uses explicit default control and reserves the same2x maximum without mutating registered prices',async()=>{
  const {params,create,budget}=setup('default');params.invocationProfile='LOCAL_LUNA_STANDARD_V1';const before=getAiModelSpec('guest-chat-luna-reasoning');const result=await generateText(params)
  const ordinary=textAttemptCostCeilingUnits({spec,system,messages,maxOutputTokens:1024})
  expect(budget.reserve.mock.calls[0]![0].reservedUnits).toBe(ordinary*2n)
  expect(create.mock.calls[0]![0].service_tier).toBe('default');expect(result.serviceTier?.outcome).toBe('STANDARD_SERVED')
  expect(getAiModelSpec('guest-chat-luna-reasoning')).toEqual(before)
  expect(before.pricingUsdPerMillionTokens).toEqual({input:.1,output:.5,cacheWrite:.125,cacheRead:.01})
 })
 it('leaves unset request/result/cost behavior unchanged',async()=>{
  const {params,create,budget}=setup('priority');const legacy:Omit<typeof params,'invocationProfile'>={...params};delete (legacy as Partial<typeof params>).invocationProfile;const result=await generateText(legacy)
  expect(create.mock.calls[0]![0]).not.toHaveProperty('service_tier');expect(result).not.toHaveProperty('serviceTier')
  expect(result.estimatedCostUsd).toBeCloseTo(.0000303,12)
  expect(budget.reserve.mock.calls[0]![0].reservedUnits).toBe(textAttemptCostCeilingUnits({spec,system,messages,maxOutputTokens:1024}))
 })
 it.each([undefined,null,'auto','flex','ultrafast','unregistered',{},44])('holds unknown tier %j, preserves observed tokens, and fails without fallback',async tier=>{
  const {params,create,budget,sink}=setup();create.mockResolvedValue({...response(),service_tier:tier})
  await expect(generateTextForCapability({...params,route})).rejects.toBeInstanceOf(LocalLunaPlannerExecutionError)
  expect(create).toHaveBeenCalledOnce();expect(budget.settleExact).not.toHaveBeenCalled();expect(budget.settleAmbiguous).toHaveBeenCalledOnce()
  expect(sink).toHaveBeenCalledWith(expect.objectContaining({usageObservationStatus:'OBSERVED',costObservationStatus:'UNKNOWN',usage:{inputTokens:100,outputTokens:40,cacheCreationInputTokens:0,cacheReadInputTokens:30},estimatedCostUsd:0,pricingVersion:expect.stringContaining('tier-unknown'),success:false}))
 })
 it('settles an unexpected premium Standard response honestly then stops the control experiment',async()=>{
  const {params,budget}=setup('priority');params.invocationProfile='LOCAL_LUNA_STANDARD_V1'
  await expect(generateText(params)).rejects.toMatchObject({code:'UNEXPECTED_FAST_TIER'})
  expect(budget.settleExact).toHaveBeenCalledWith(expect.anything(),6060n)
 })
 it('settles known cost but rejects missing provider identity',async()=>{
  const {params,create,budget}=setup('default');create.mockResolvedValue({...response('default'),id:undefined})
  await expect(generateText(params)).rejects.toMatchObject({code:'MISSING_PROVIDER_RESPONSE_ID'})
  expect(budget.settleExact).toHaveBeenCalledWith(expect.anything(),3030n)
 })
 it('accounts incomplete output at observed tier, without retry',async()=>{
  const {params,create,budget,sink}=setup();create.mockResolvedValue({...response(),status:'incomplete'})
  await expect(generateTextForCapability({...params,route})).rejects.toMatchObject({code:'PLANNER_OPERATION_FAILED'})
  expect(budget.settleExact).toHaveBeenCalledWith(expect.anything(),6060n);expect(create).toHaveBeenCalledOnce();expect(sink).toHaveBeenCalledWith(expect.objectContaining({success:false,serviceTier:expect.objectContaining({observedTier:'fast'})}))
 })
 it('transport failure leaves fullhold and does not retry',async()=>{
  const {params,create,budget}=setup();create.mockRejectedValue(new Error('synthetic transport'))
  await expect(generateTextForCapability({...params,route})).rejects.toThrow();expect(create).toHaveBeenCalledOnce();expect(budget.settleAmbiguous).toHaveBeenCalledOnce()
 })
 it.each(['settlement','usage'])('does not dispatch again after %s accounting outage',async failure=>{
  const {params,create,budget,sink}=setup()
  if(failure==='settlement')budget.settleExact.mockRejectedValue(new Error('offline accounting'))
  else sink.mockRejectedValue(new Error('offline persistence'))
  await expect(generateTextForCapability({...params,route})).rejects.toMatchObject({code:'PLANNER_ACCOUNTING_FAILED'})
  expect(create).toHaveBeenCalledOnce()
 })
 it('blocks the2x reservation at the shared cumulative ceiling before dispatch',async()=>{
  const {params,create,budget}=setup();const ordinary=textAttemptCostCeilingUnits({spec,system,messages,maxOutputTokens:1024})
  await expect(generateText({...params,budgetGate:withAiRequestBudgetCeiling(budget,ordinary)})).rejects.toMatchObject({code:'REQUEST_BUDGET_CEILING_EXCEEDED'})
  expect(create).not.toHaveBeenCalled();expect(budget.reserve).not.toHaveBeenCalled()
 })
 it('pins profile and candidate despite mutation during reservation',async()=>{
  const {params,create,budget}=setup();const mutable={...params,route:structuredClone(route)}
  budget.reserve.mockImplementation(async attempt=>{mutable.invocationProfile='LOCAL_LUNA_STANDARD_V1';mutable.route.candidates.push({...mutable.route.candidates[0]!,fallback:true});return{id:'hold',reservedUnits:attempt.reservedUnits}})
  const result=await generateTextForCapability(mutable);expect(create.mock.calls[0]![0].service_tier).toBe('fast');expect(result.serviceTier?.profile).toBe('LOCAL_LUNA_FAST_V1');expect(create).toHaveBeenCalledOnce()
 })
 it.each(['attempts','output','stream','provider','extra-route','unknown-profile','cache-breakpoint'])('rejects incompatible %s before budget/SDK',async kind=>{
  const {params,create,budget}=setup();const request:Parameters<typeof generateTextForCapability>[0]={...params,route:structuredClone(route)}
  if(kind==='attempts')request.maxAttempts=2
  if(kind==='output')request.maxOutputTokens=2048
  if(kind==='stream')request.onTextDelta=()=>{}
  if(kind==='cache-breakpoint')request.system=[{type:'text',text:'cached',cache_control:{type:'ephemeral'}}]
  if(kind==='provider')request.route.candidates[0]!.provider='anthropic'
  if(kind==='extra-route')request.route.candidates.push({...request.route.candidates[0]!})
  if(kind==='unknown-profile')request.invocationProfile='UNREVIEWED' as LocalLunaPlannerProfile
  await expect(generateTextForCapability(request)).rejects.toThrow();expect(create).not.toHaveBeenCalled();expect(budget.reserve).not.toHaveBeenCalled()
 })
 it('rejects direct adapter streaming selected profile',async()=>{
  const {create}=setup();await expect(createOpenAiTextStream({spec,system,messages,maxOutputTokens:1024,timeoutMs:1000,onTextDelta:()=>{},invocationProfile:'LOCAL_LUNA_FAST_V1'})).rejects.toThrow();expect(create).not.toHaveBeenCalled()
 })
 it.each(['model','missing-model','missing-usage','fractional-input','negative-output','missing-write','cache-overlap','positive-write','12h-write','output-bound','input-bound','total','reasoning','unknown-input-partition','unknown-output-partition'])('holds malformed raw %s without exact settlement or provider fallback',async kind=>{
  const {params,create,budget,sink}=setup();let bad:unknown=response()
  if(kind==='model')bad={...response(),model:'other-model'}
  if(kind==='missing-model')bad={...response(),model:undefined}
  if(kind==='missing-usage')bad={...response(),usage:undefined}
  if(kind==='fractional-input')bad={...response(),usage:{...usage,input_tokens:130.5}}
  if(kind==='negative-output')bad={...response(),usage:{...usage,output_tokens:-1}}
  if(kind==='missing-write')bad={...response(),usage:{...usage,input_tokens_details:{cached_tokens:30}}}
  if(kind==='cache-overlap')bad={...response(),usage:{...usage,input_tokens_details:{cached_tokens:131,cache_write_tokens:0}}}
  if(kind==='positive-write')bad={...response(),usage:{...usage,input_tokens_details:{cached_tokens:30,cache_write_tokens:1}}}
  if(kind==='12h-write')bad={...response(),usage:{...usage,input_tokens_details:{cached_tokens:30,cache_write_tokens:0,cache_write_tokens_details:{ttl_12h_tokens:1}}}}
  if(kind==='output-bound')bad={...response(),usage:{...usage,output_tokens:1025,total_tokens:1155}}
  if(kind==='input-bound')bad={...response(),usage:{...usage,input_tokens:200001,total_tokens:200041}}
  if(kind==='total')bad={...response(),usage:{...usage,total_tokens:171}}
  if(kind==='reasoning')bad={...response(),usage:{...usage,output_tokens_details:{reasoning_tokens:41}}}
  if(kind==='unknown-input-partition')bad={...response(),usage:{...usage,input_tokens_details:{cached_tokens:30,cache_write_tokens:0,audio_tokens:1}}}
  if(kind==='unknown-output-partition')bad={...response(),usage:{...usage,output_tokens_details:{reasoning_tokens:10,audio_tokens:1}}}
  create.mockResolvedValue(bad)
  await expect(generateTextForCapability({...params,route})).rejects.toMatchObject({code:'INVALID_PLANNER_USAGE'})
  expect(create).toHaveBeenCalledOnce();expect(budget.settleExact).not.toHaveBeenCalled();expect(budget.settleAmbiguous).toHaveBeenCalledOnce()
  expect(sink).toHaveBeenCalledWith(expect.objectContaining({usageObservationStatus:'UNKNOWN',costObservationStatus:'UNKNOWN',estimatedCostUsd:0,success:false}))
 })
 it('charges valid usage once but stops a malformed planner operation at the accounted parse boundary',async()=>{
  const {params,create,budget,sink}=setup()
  await expect(generateTextForCapability({...params,route,parseResponse:()=>{throw Error('invalid plan')}})).rejects.toMatchObject({code:'PLANNER_OPERATION_FAILED'})
  expect(create).toHaveBeenCalledOnce();expect(budget.settleExact).toHaveBeenCalledWith(expect.anything(),6060n)
  expect(sink).toHaveBeenCalledWith(expect.objectContaining({success:false,usageObservationStatus:'OBSERVED',costObservationStatus:'OBSERVED'}))
 })

})
