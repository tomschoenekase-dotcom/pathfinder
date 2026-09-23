import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ run: vi.fn(), venue: vi.fn() }))
vi.mock('../client', () => ({ db: {
  agentRun: { findFirst: mocks.run },
  prospectVenue: { findFirst: mocks.venue },
} }))

import { issueNativeSalesWriterAgentActor,
  revalidateNativeSalesWriterAgent,
  revalidateNativeSalesWriterAgentBound } from './prospect-native-writer-agent'
import { requireSalesOperator } from './prospect-sales-actions'
import { importNativeWriterResult, type NativeWriterResult } from './prospect-sales-writer'
import { salesHash } from './prospect-sales-snapshot'

const invocation = {
  tenantId: 'tenant', venueId: 'bridge-venue',
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  agentRunId: 'run', leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  credentialId: 'credential', correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
}
const live = () => ({ agentIdentity: { id: 'agent',
  accessCapabilities: ['prospects.native-writer', 'prospects.correspondence.read'] },
  scopeSnapshot: { accessCapabilities: ['prospects.native-writer', 'prospects.correspondence.read'],
    prospectScope: { mode: 'TERRITORIES', territoryIds: ['territory-1'] },
    promptIdentity: 'crm-writer@1' } })

describe('opaque native writer agent authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.run.mockResolvedValue(live())
    mocks.venue.mockResolvedValue({ id: 'native-venue' })
  })
  it('binds exact live run, lease, bridge and territory to one native venue', async () => {
    const actor = await issueNativeSalesWriterAgentActor({ invocation,
      venueId: 'native-venue', organizationId: 'org-1' })
    expect(actor).toEqual({ type: 'AGENT', role: 'NATIVE_SALES_WRITER', id: 'agent' })
    expect(Object.keys(actor)).toEqual(['type', 'role', 'id'])
    expect(() => requireSalesOperator(actor)).toThrow('native platform operator')
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'run', status: 'RUNNING',
        executionLeaseToken: invocation.leaseToken,
        executionBridgeSession: expect.objectContaining({ status: 'ONLINE',
          credentialId: invocation.credentialId }) }) }))
    expect(mocks.venue).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'native-venue', organizationId: 'org-1',
        organization: expect.objectContaining({ territoryId: { in: ['territory-1'] } }) }) }))
    await expect(revalidateNativeSalesWriterAgentBound(actor, 'other-venue'))
      .rejects.toThrow('Live leased native-writer grant')
  })
  it('rejects fabricated actors and revoked live or frozen capability', async () => {
    await expect(revalidateNativeSalesWriterAgent({ type: 'AGENT',
      role: 'NATIVE_SALES_WRITER', id: 'agent' }, 'native-venue', 'org-1'))
      .rejects.toThrow('Live leased native-writer grant')
    mocks.run.mockResolvedValue({ ...live(), agentIdentity: { id: 'agent',
      accessCapabilities: [] } })
    await expect(issueNativeSalesWriterAgentActor({ invocation,
      venueId: 'native-venue', organizationId: 'org-1' }))
      .rejects.toThrow('Live leased native-writer grant')
    mocks.run.mockResolvedValue({ ...live(), agentIdentity: { id: 'agent',
      accessCapabilities: ['prospects.native-writer'] } })
    await expect(issueNativeSalesWriterAgentActor({ invocation,
      venueId: 'native-venue', organizationId: 'org-1' }))
      .rejects.toThrow('Live leased native-writer grant')
    mocks.run.mockResolvedValue({ ...live(), scopeSnapshot: {
      accessCapabilities: ['prospects.native-writer'], prospectScope: { mode: 'ALL' },
      promptIdentity: 'crm-writer@1' } })
    await expect(issueNativeSalesWriterAgentActor({ invocation,
      venueId: 'native-venue', organizationId: 'org-1' }))
      .rejects.toThrow('Live leased native-writer grant')
  })
  it('rejects moved territory or expired lease at a later mutation check', async () => {
    const actor = await issueNativeSalesWriterAgentActor({ invocation,
      venueId: 'native-venue', organizationId: 'org-1' })
    mocks.venue.mockResolvedValueOnce(null)
    await expect(revalidateNativeSalesWriterAgentBound(actor, 'native-venue'))
      .rejects.toThrow('Live leased native-writer grant')
    mocks.run.mockResolvedValueOnce(null)
    await expect(revalidateNativeSalesWriterAgentBound(actor, 'native-venue'))
      .rejects.toThrow('Live leased native-writer grant')
  })
  it('does not return a conflict-recovered immutable receipt after live authority is lost', async () => {
    const actor = await issueNativeSalesWriterAgentActor({ invocation,
      venueId: 'native-venue', organizationId: 'org-1' })
    const binding = { venueId: 'native-venue', organizationId: 'org-1',
      preparationId: 'prep', nativeSnapshotHash: 'a'.repeat(64),
      preparationHash: 'b'.repeat(64), componentCodeHash: 'c'.repeat(64),
      fileSetHash: 'd'.repeat(64), selectionId: null,
      routeHash: 'e'.repeat(64), routeKind: 'email',
      recipient: 'fixture@example.invalid', formUrl: null,
      threadHash: 'f'.repeat(64), libraryHash: '1'.repeat(64),
      wltHash: '2'.repeat(64), expectedDraftId: null,
      expectedVenueDraftId: null, expectedMeaningReviewId: null,
      expectedReadReviewId: null }
    const result: NativeWriterResult = { schema: 'torchiko.native-writer-result/1',
      taskId: 'writer-task_' + salesHash(binding), binding,
      generatedBy: { kind: 'model', identity: 'synthetic writer' },
      subject: 'Hello', body: 'Hi', annotations: [], languageUses: [],
      assessment: null }
    const findUnique = vi.fn().mockResolvedValue({ id: 'old-receipt' })
    const client = { $transaction: vi.fn(async () => {
      throw Object.assign(new Error('serialization retry'), { code: 'P2034' })
    }), agentRun: { findFirst: mocks.run },
    prospectVenue: { findFirst: mocks.venue },
    prospectActivity: { findUnique } }
    mocks.run.mockResolvedValueOnce(null)
    await expect(importNativeWriterResult({ result, component: {}, actor,
      assess: vi.fn() }, client as never)).rejects.toThrow('Live leased native-writer grant')
    expect(findUnique).not.toHaveBeenCalled()
  })
})
