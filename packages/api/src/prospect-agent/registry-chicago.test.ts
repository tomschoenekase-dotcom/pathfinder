import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), health: vi.fn(), add: vi.fn(), append: vi.fn(), change: vi.fn(), relationship: vi.fn(), run: vi.fn(), preview:vi.fn(),queue:vi.fn(),claim:vi.fn(),complete:vi.fn(),release:vi.fn(),lifecycle:vi.fn(),refresh:vi.fn() }))
vi.mock('../chicago-intelligence-research',()=>({previewChicagoResearch:mocks.preview,queueChicagoResearch:mocks.queue,claimChicagoResearch:mocks.claim,completeChicagoResearch:mocks.complete,releaseChicagoResearch:mocks.release}))
vi.mock('../chicago-intelligence-maintenance',()=>({maintainChicagoVenue:mocks.lifecycle,refreshChicagoVenueRankings:mocks.refresh}))
vi.mock('@pathfinder/db', () => ({ db: { agentRun: { findFirst: mocks.run } }, withTenantIsolationBypass: (fn: () => unknown) => fn() }))
vi.mock('../prospect-reply-content', () => ({ readProspectReplyContentForAgent: vi.fn() }))
vi.mock('../prospect-sales-workflow', () => ({ applyNativeSalesAction: vi.fn(), getNativeSalesWorkflow: vi.fn(), readAuthenticatedSalesReadiness: vi.fn() }))
vi.mock('../chicago-intelligence-service', () => ({ listChicagoVenues: mocks.list, getChicagoVenue: mocks.get, getChicagoHealth: mocks.health, addChicagoVenue: mocks.add, appendChicagoEvidence: mocks.append, changeChicagoVenue: mocks.change, proposeChicagoDuplicate: mocks.relationship }))

import { createProspectAgentRegistry, resolveVerifiedProspectAgentContext, type ProspectAgentInvocation, type VerifiedProspectAgentContext } from './registry'
import { chicagoDirectoryInput } from '../chicago-intelligence-contract'

const invocation: ProspectAgentInvocation = {
  tenantId: 'tenant', venueId: 'bridge-venue', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  agentRunId: 'run', leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', credentialId: 'credential',
  correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
}
const scope = { mode: 'TERRITORIES' as const, territoryIds: ['chicago-territory'] }
const context = (capabilities: VerifiedProspectAgentContext['capabilities'] = ['prospects.read', 'prospects.maintain']): VerifiedProspectAgentContext => ({
  tenantId: 'tenant', venueId: 'bridge-venue', agentRunId: 'run', actorId: 'agent', initiatorId: 'operator',
  capabilities, scope, modelProvider: 'codex-bridge', modelName: 'fixture', promptIdentity: 'venue-research@1',
  requestedOperation: 'venue-maintenance', correlationId: invocation.correlationId,
})
const evidence = { url: 'https://museum.example.org/visit', researchedAt: '2026-09-22', statement: 'The official visitor page identifies the physical venue and location.', firstParty: true }
const add = { idempotencyKey: 'discover-1', name: 'Example museum', city: 'Chicago', state: 'IL', territoryId: 'chicago-territory', website: 'https://museum.example.org', evidence, territoryRationale: 'The official address places the physical venue in Chicago.' }
const change = { idempotencyKey: 'research-1', venueId: 'venue', expectedVersion: 1, field: 'venueType', value: 'History museum', evidence }
const registry = (capabilities?: VerifiedProspectAgentContext['capabilities']) => createProspectAgentRegistry({ resolveContext: async () => context(capabilities) })

describe('Chicago venue intelligence agent adapters', () => {
  beforeEach(() => vi.resetAllMocks())

  it('keeps bounded research queue writes separate from read and legacy research grants',async()=>{
    const input={idempotencyKey:'queue-1',selections:[{venueId:'venue',expectedVersion:3,gapKeys:['knowledgeRichness']}]}
    await expect(registry(['prospects.read','prospects.research']).callTool('torchiko.prospects.queue_venue_research',input,invocation)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'})
    await registry().callTool('torchiko.prospects.queue_venue_research',input,invocation)
    expect(mocks.queue).toHaveBeenCalledWith(input,expect.objectContaining({id:'agent',type:'AGENT',runId:'run',scope}))
    await expect(registry().callTool('torchiko.prospects.queue_venue_research',{...input,scope:{mode:'ALL'}},invocation)).rejects.toThrow()
    await expect(registry().callTool('torchiko.prospects.queue_venue_research',{...input,selections:Array.from({length:11},(_,i)=>({...input.selections[0],venueId:`v${i}`}))},invocation)).rejects.toThrow()
  })

  it('passes exact leased completion and retry results without granting override or outreach',async()=>{
    const input={idempotencyKey:'complete-1',venueId:'venue',jobId:'job',claimToken:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',outcome:'BLOCKED',summary:'Requested evidence remains unknown within the research boundary.',evidence:[],unknowns:[{gapKey:'knowledgeRichness',reason:'The first-party source did not establish the requested fact.'}]}
    const receipt={receiptId:'receipt',replayed:true,status:'BLOCKED',evidenceIds:[]}
    mocks.complete.mockResolvedValue(receipt)
    expect(await registry().callTool('torchiko.prospects.complete_venue_research',input,invocation)).toBe(receipt)
    expect(mocks.complete).toHaveBeenCalledWith(input,expect.objectContaining({scope,type:'AGENT'}))
    expect(registry().listTools().some(tool=>tool.name.includes('override'))).toBe(false)
  })

  it('routes reversible lifecycle through the trusted actor and validates target versions',async()=>{
    const input={idempotencyKey:'archive-1',venueId:'venue',expectedVersion:3,action:'archive',rationale:'Retain this location as inactive without deleting its history.'}
    await registry().callTool('torchiko.prospects.maintain_venue_lifecycle',input,invocation)
    expect(mocks.lifecycle).toHaveBeenCalledWith(input,expect.objectContaining({scope,type:'AGENT'}))
    await expect(registry().callTool('torchiko.prospects.maintain_venue_lifecycle',{...input,action:'supersede',supersededByVenueId:'target'},invocation)).rejects.toThrow()
    await expect(registry().callTool('torchiko.prospects.refresh_venue_rankings',{idempotencyKey:'refresh',rationale:'Materialize the current ranking version with original history retained.',targets:[{venueId:'venue',expectedVersion:3},{venueId:'venue',expectedVersion:3}]},invocation)).rejects.toThrow()
  })

  it('uses the exact UI directory input and frozen scope, with bounded pagination', async () => {
    const input = { query: 'museum', geography: 'chicago-proper', page: 2, pageSize: 25, sorts: [{ field: 'productFit', direction: 'desc' }] }
    const result = { items: [], total: 40, page: 2, pageSize: 25 }
    mocks.list.mockResolvedValue(result)
    expect(await registry().callTool('torchiko.prospects.search_venues', input, invocation)).toBe(result)
    expect(mocks.list).toHaveBeenCalledWith(chicagoDirectoryInput.parse(input), scope)
    await expect(registry().callTool('torchiko.prospects.search_venues', { pageSize: 101 }, invocation)).rejects.toThrow()
    await expect(registry().callTool('torchiko.prospects.search_venues', { scope: { mode: 'ALL' } }, invocation)).rejects.toThrow()
  })

  it('requires read capability independently of maintenance and does not grant correspondence access', async () => {
    await expect(registry(['prospects.maintain']).callTool('torchiko.prospects.read_venue', { venueId: 'venue' }, invocation)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' })
    await expect(registry(['prospects.maintain']).callTool('torchiko.prospects.read_selected_reply_content', { organizationId: 'org', threadId: 'thread', messageId: 'message' }, invocation)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' })
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('requires maintenance on live identity and frozen run separately', async () => {
    for (const [live, frozen] of [[['prospects.read'], ['prospects.maintain']], [['prospects.maintain'], ['prospects.read']]]) {
      mocks.run.mockResolvedValue({ id: 'run', tenantId: 'tenant', venueId: 'bridge-venue', initiatedById: 'operator', requestedOperation: 'venue-maintenance', modelProvider: null, modelName: null,
        scopeSnapshot: { accessCapabilities: frozen, prospectScope: scope, promptIdentity: 'venue-research@1' }, agentIdentity: { id: 'agent', accessCapabilities: live } })
      await expect(createProspectAgentRegistry().callTool('torchiko.prospects.add_venue', add, invocation)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' })
    }
    expect(mocks.add).not.toHaveBeenCalled()
    mocks.run.mockResolvedValue({ id: 'run', tenantId: 'tenant', venueId: 'bridge-venue', initiatedById: 'operator', requestedOperation: 'venue-maintenance', modelProvider: null, modelName: null,
      scopeSnapshot: { accessCapabilities: ['prospects.maintain'], prospectScope: scope, promptIdentity: 'venue-research@1' }, agentIdentity: { id: 'agent', accessCapabilities: ['prospects.maintain'] } })
    expect((await resolveVerifiedProspectAgentContext(invocation)).capabilities).toEqual(['prospects.maintain'])
  })

  it('derives every mutation actor from authenticated context and rejects caller authority', async () => {
    mocks.add.mockResolvedValue({ receiptId: 'receipt', venueId: 'venue', replayed: false })
    await registry().callTool('torchiko.prospects.add_venue', add, invocation)
    expect(mocks.add).toHaveBeenCalledWith(add, { id: 'agent', type: 'AGENT', runId: 'run', scope, capabilities: ['prospects.read', 'prospects.maintain'] })
    for (const injected of [{ actor: { id: 'operator', type: 'HUMAN' } }, { scope: { mode: 'ALL' } }, { capabilities: ['prospects.maintain'] }, { runId: 'fake-run' }]) {
      await expect(registry().callTool('torchiko.prospects.add_venue', { ...add, ...injected }, invocation)).rejects.toThrow()
    }
    expect(mocks.add).toHaveBeenCalledTimes(1)
  })

  it('propagates service territory denial without bypass or fallback', async () => {
    mocks.add.mockRejectedValue(Object.assign(new Error('Outside frozen territory'), { code: 'FORBIDDEN' }))
    await expect(registry().callTool('torchiko.prospects.add_venue', { ...add, territoryId: 'other-territory' }, invocation)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.add.mock.calls[0]?.[1].scope).toEqual(scope)
    expect(mocks.change).not.toHaveBeenCalled()
  })

  it('preserves exact stale version and retry outcomes without manufacturing success', async () => {
    const conflict = Object.assign(new Error('Expected 1, current 2'), { code: 'CONFLICT', currentVersion: 2 })
    mocks.change.mockRejectedValueOnce(conflict)
    await expect(registry().callTool('torchiko.prospects.change_venue', change, invocation)).rejects.toBe(conflict)
    expect(mocks.change.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 1, mode: 'propose' })
    const receipt = { receiptId: 'receipt', venueId: 'venue', revision: 2, replayed: true }
    mocks.change.mockResolvedValue(receipt)
    expect(await registry().callTool('torchiko.prospects.change_venue', change, invocation)).toBe(receipt)
    expect(mocks.change.mock.calls[1]?.[0].idempotencyKey).toBe('research-1')
    await expect(registry().callTool('torchiko.prospects.change_venue', { ...change, expectedVersion: 0 }, invocation)).rejects.toThrow()
  })

  it('requires first-party public evidence and preserves unknowns by rejecting invented fields', async () => {
    for (const invalid of [{ ...evidence, firstParty: false }, { ...evidence, url: 'http://127.0.0.1/private' }, { ...evidence, url: 'javascript:alert(1)' }]) {
      await expect(registry().callTool('torchiko.prospects.add_venue', { ...add, evidence: invalid }, invocation)).rejects.toThrow()
    }
    await expect(registry().callTool('torchiko.prospects.change_venue', { ...change, field: 'privateContactEmail' }, invocation)).rejects.toThrow()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.change).not.toHaveBeenCalled()
  })

  it('reads detail, explanation and data health through the same scoped service owner', async () => {
    const detail = { venueId: 'venue', ranking: { version: 'v1', productFit: { value: null } }, researchGaps: [{ key: 'knowledgeRichness' }], sources: [] }
    mocks.get.mockResolvedValue(detail)
    expect(await registry().callTool('torchiko.prospects.read_venue', { venueId: 'venue' }, invocation)).toBe(detail)
    expect(await registry().callTool('torchiko.prospects.explain_venue', { venueId: 'venue' }, invocation)).toEqual({ venueId: 'venue', ranking: detail.ranking, researchGaps: detail.researchGaps })
    expect(mocks.get).toHaveBeenCalledWith('venue', scope)
    await registry().callTool('torchiko.prospects.read_data_health', {}, invocation)
    expect(mocks.health).toHaveBeenCalledWith(scope)
    await expect(registry().callTool('torchiko.prospects.read_data_health', { scope: { mode: 'ALL' } }, invocation)).rejects.toThrow()
  })

  it('routes duplicate and same-operator proposals to review without merge authority', async () => {
    const input = { idempotencyKey: 'duplicate-1', venueId: 'venue', expectedVersion: 2, otherVenueId: 'other', relation: 'same-operator', reason: 'The official operator lists both venues.', evidence }
    const receipt = { receiptId: 'receipt', reviewId: 'review', replayed: false }
    mocks.relationship.mockResolvedValue(receipt)
    expect(await registry().callTool('torchiko.prospects.propose_venue_relationship', input, invocation)).toBe(receipt)
    expect(mocks.relationship).toHaveBeenCalledWith(input, expect.objectContaining({ scope, type: 'AGENT' }))
    expect(registry().listTools().find((tool) => tool.name === 'torchiko.prospects.propose_venue_relationship')?.humanReviewRequired).toBe(true)
  })

  it('publishes bounded honest tool contracts and keeps maintenance separate from existing research/writer capabilities', () => {
    const tools = registry().listTools()
    const additions = tools.filter((tool) => ['search_venues', 'read_venue', 'explain_venue', 'read_data_health', 'add_venue', 'change_venue', 'append_venue_evidence', 'propose_venue_relationship'].some((name) => tool.name === `torchiko.prospects.${name}`))
    expect(additions).toHaveLength(8)
    expect(additions.every((tool) => tool.inputSchema.additionalProperties === false && tool.examples.length > 0 && tool.relatedTools.length > 0)).toBe(true)
    expect(additions.filter((tool) => tool.mutates).every((tool) => tool.capability === 'prospects.maintain' && tool.idempotent)).toBe(true)
    expect(tools.some((tool) => /merge|delete|unsuppress/.test(tool.name))).toBe(false)
  })

  it('appends supported observations using frozen maintenance authority and preserves retry/conflict results', async () => {
    const input = { idempotencyKey: 'fit-1', venueId: 'venue', expectedVersion: 3, evidence,
      observation: { kind: 'fit', key: 'knowledgeRichness', value: 90, reason: 'Official collection pages document substantial venue-specific content.' } }
    await expect(registry(['prospects.read', 'prospects.research']).callTool('torchiko.prospects.append_venue_evidence', input, invocation)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' })
    const receipt = { receiptId: 'receipt', replayed: true, venueId: 'venue', revision: 4, evidenceId: 'evidence' }
    mocks.append.mockResolvedValue(receipt)
    expect(await registry().callTool('torchiko.prospects.append_venue_evidence', input, invocation)).toBe(receipt)
    expect(mocks.append).toHaveBeenCalledWith(input, { id: 'agent', type: 'AGENT', runId: 'run', scope, capabilities: ['prospects.read', 'prospects.maintain'] })
    const conflict = Object.assign(new Error('Stale observation'), { code: 'CONFLICT' })
    mocks.append.mockRejectedValueOnce(conflict)
    await expect(registry().callTool('torchiko.prospects.append_venue_evidence', input, invocation)).rejects.toBe(conflict)
    await expect(registry().callTool('torchiko.prospects.append_venue_evidence', { ...input, actor: 'tom' }, invocation)).rejects.toThrow()
    await expect(registry().callTool('torchiko.prospects.append_venue_evidence', { ...input, observation: { kind: 'override', value: 100 } }, invocation)).rejects.toThrow()
    expect(mocks.append).toHaveBeenCalledTimes(2)
  })

  it('returns held territory candidates without inventing a canonical venue, organization or revision', async () => {
    const held = { receiptId: 'receipt-held', replayed: false, venueId: null, quarantined: true, reviewId: 'review', matched: false }
    mocks.add.mockResolvedValue(held)
    const result = await registry().callTool('torchiko.prospects.add_venue', add, invocation)
    expect(result).toBe(held)
    expect(result).not.toHaveProperty('organizationId')
    expect(result).not.toHaveProperty('revision')
  })
})
