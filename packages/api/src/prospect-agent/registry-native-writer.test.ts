import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ issue: vi.fn(), revalidate: vi.fn(),
  action: vi.fn(), read: vi.fn(), native: vi.fn(), readiness: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  db: {}, withTenantIsolationBypass: (operation: () => unknown) => operation(),
  issueNativeSalesWriterAgentActor: mocks.issue,
  revalidateNativeSalesWriterAgentBound: mocks.revalidate,
  readNativeSalesSnapshot: mocks.native,
}))
vi.mock('../prospect-sales-workflow', () => ({
  applyNativeSalesAction: mocks.action, getNativeSalesWorkflow: mocks.read,
  readAuthenticatedSalesReadiness: mocks.readiness,
}))
vi.mock('../prospect-reply-content', () => ({ readProspectReplyContentForAgent: vi.fn() }))

import { createProspectAgentRegistry, type ProspectAgentInvocation,
  type VerifiedProspectAgentContext } from './registry'

const invocation: ProspectAgentInvocation = {
  tenantId: 'tenant', venueId: 'bridge-venue',
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agentRunId: 'run',
  leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', credentialId: 'credential',
  correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
}
function context(capabilities: VerifiedProspectAgentContext['capabilities'] = [
  'prospects.native-writer', 'prospects.correspondence.read',
]): VerifiedProspectAgentContext {
  return { tenantId: 'tenant', venueId: 'bridge-venue', agentRunId: 'run',
    actorId: 'agent', initiatorId: 'operator', capabilities,
    scope: { mode: 'TERRITORIES', territoryIds: ['territory-1'] },
    modelProvider: 'codex-bridge', modelName: 'synthetic-unit',
    promptIdentity: 'crm-writer@1', requestedOperation: 'explicit_native_writer',
    correlationId: invocation.correlationId }
}
const hash = 'a'.repeat(64)
const scope = { organizationId: 'org', venueId: 'native-venue' }
const result = {
  schema: 'torchiko.native-writer-result/1', taskId: 'writer-task_' + hash,
  binding: { ...scope, preparationId: 'prep', nativeSnapshotHash: hash,
    preparationHash: hash, componentCodeHash: hash, fileSetHash: hash,
    selectionId: null, routeHash: hash, routeKind: 'email',
    recipient: 'fixture@example.invalid', formUrl: null, threadHash: hash,
    libraryHash: hash, wltHash: hash, expectedDraftId: null,
    expectedVenueDraftId: null, expectedMeaningReviewId: null,
    expectedReadReviewId: null },
  generatedBy: { kind: 'model', identity: 'synthetic unit writer' },
  subject: 'Hello', body: 'Hi',
  annotations: [
    { annotation_id: 's', section: 'subject', start: 0, end: 5,
      quote: 'Hello', category: 'NONFACTUAL', claim_ids: [],
      reason: 'Synthetic greeting', answers: [] },
    { annotation_id: 'b', section: 'body', start: 0, end: 2,
      quote: 'Hi', category: 'NONFACTUAL', claim_ids: [],
      reason: 'Synthetic greeting', answers: [] },
  ], languageUses: [], assessment: null,
}

describe('verified native prospect writer tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.issue.mockResolvedValue({ type: 'AGENT', role: 'NATIVE_SALES_WRITER', id: 'agent' })
    mocks.revalidate.mockResolvedValue(undefined)
    mocks.action.mockResolvedValue({ organizationId: 'org', venueId: 'native-venue',
      snapshotHash: hash, preparation: { id: 'prep', stale: false } })
    mocks.native.mockResolvedValue({ organization: { id: 'org' },
      venue: { id: 'native-venue' }, snapshotHash: hash })
    mocks.readiness.mockResolvedValue({
      component: { state: 'paths-present-runtime-unverified' },
      writingGuide: { id: 'torchiko-v0.2',
        sourceRef: 'torchiko-writing-reference:v0.2-r001/TORCHIKO-WRITING-REFERENCE.md',
        state: 'available', sha256: hash },
    })
    mocks.read.mockResolvedValue({ organizationId: 'org', venueId: 'native-venue',
      snapshotHash: hash, preparation: { id: 'prep', stale: false },
      writerTask: { schema: 'torchiko.native-writer-task/1', taskId: 'task', SEND_AUTHORIZED: false } })
  })
  const registry = (capabilities?: VerifiedProspectAgentContext['capabilities']) =>
    createProspectAgentRegistry({ resolveContext: async () => context(capabilities) })

  it('requires distinct live/frozen writer and correspondence capabilities', async () => {
    await expect(registry(['prospects.correspondence.read']).callTool(
      'torchiko.prospects.prepare_native_writer',
      { ...scope, expectedSnapshotHash: hash }, invocation))
      .rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' })
    await expect(registry(['prospects.native-writer']).callTool(
      'torchiko.prospects.read_native_writer_task', scope, invocation))
      .rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' })
    expect(mocks.issue).not.toHaveBeenCalled()
  })
  it('reads first, explicitly prepares, then exports only an exact scoped no-send task', async () => {
    mocks.read.mockResolvedValueOnce({ organizationId: 'org', venueId: 'native-venue',
      snapshotHash: hash, preparation: null, writerTask: null,
      writerHold: 'WRITER_PREPARATION_REQUIRED' })
    const first = await registry().callTool('torchiko.prospects.read_native_writer_task',
      scope, invocation)
    expect(first).toMatchObject({ organizationId: 'org', venueId: 'native-venue',
      snapshotHash: hash, preparationId: null, task: null,
      hold: 'PREPARATION_REQUIRED', writingGuide: { state: 'available', sha256: hash },
      SEND_AUTHORIZED: false })
    expect(JSON.stringify(first)).not.toContain('text')
    const prepared = await registry().callTool('torchiko.prospects.prepare_native_writer',
      { ...scope, expectedSnapshotHash: hash }, invocation)
    expect(prepared).toEqual({ venueId: 'native-venue', preparationId: 'prep',
      snapshotHash: hash, stale: false, SEND_AUTHORIZED: false })
    expect(mocks.issue).toHaveBeenCalledWith({ invocation,
      venueId: 'native-venue', organizationId: 'org' })
    expect(mocks.action).toHaveBeenCalledWith({ action: 'prepare',
      input: { venueId: 'native-venue', expectedSnapshotHash: hash } },
      expect.objectContaining({ type: 'AGENT', id: 'agent' }), 'authenticated-admin')
    const task = await registry().callTool('torchiko.prospects.read_native_writer_task',
      scope, invocation)
    expect(task).toMatchObject({ snapshotHash: hash, preparationId: 'prep',
      task: { taskId: 'task' }, hold: null,
      writingGuide: { state: 'available', sha256: hash }, SEND_AUTHORIZED: false })
    expect(mocks.revalidate).toHaveBeenCalled()
  })
  it('returns a safe hold and exact snapshot when the component is not installed', async () => {
    mocks.readiness.mockResolvedValue({
      component: { state: 'unavailable' },
      writingGuide: { id: 'torchiko-v0.2', sourceRef: 'known-guide',
        state: 'unavailable', sha256: null },
    })
    const first = await registry().callTool('torchiko.prospects.read_native_writer_task',
      scope, invocation)
    expect(first).toMatchObject({ snapshotHash: hash, task: null,
      hold: 'COMPONENT_UNAVAILABLE', writingGuide: { state: 'unavailable' } })
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('does not return a task after the exact organization changes during the read', async () => {
    mocks.native.mockResolvedValueOnce({ organization: { id: 'org' },
      venue: { id: 'native-venue' }, snapshotHash: hash })
      .mockResolvedValueOnce({ organization: { id: 'moved-org' },
        venue: { id: 'native-venue' }, snapshotHash: 'b'.repeat(64) })
    await expect(registry().callTool('torchiko.prospects.read_native_writer_task',
      scope, invocation)).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(mocks.revalidate).toHaveBeenCalled()
  })
  it('retains exact replay receipt after mutable view moves, pending operator review', async () => {
    mocks.action.mockResolvedValue({ schema: 'torchiko.native-writer-import-receipt-only/1',
      writerImportReceipt: { id: 'receipt', draftId: 'draft', replayed: true },
      currentViewAvailable: false, SEND_AUTHORIZED: false })
    const imported = await registry().callTool('torchiko.prospects.import_native_writer_result',
      { ...scope, expectedSnapshotHash: hash, result }, invocation)
    expect(imported).toEqual({ receiptId: 'receipt', draftId: 'draft',
      replayed: true, pendingOperatorReview: true, SEND_AUTHORIZED: false })
  })
  it('rejects changed identity, revoked lease and model assessment without importing', async () => {
    mocks.issue.mockResolvedValueOnce({ type: 'AGENT', role: 'NATIVE_SALES_WRITER', id: 'other' })
    await expect(registry().callTool('torchiko.prospects.read_native_writer_task',
      scope, invocation)).rejects.toMatchObject({ code: 'INVALID_CONTEXT' })
    mocks.revalidate.mockRejectedValueOnce(new Error('revoked lease'))
    await expect(registry().callTool('torchiko.prospects.read_native_writer_task',
      scope, invocation)).rejects.toThrow('revoked lease')
    await expect(registry().callTool('torchiko.prospects.import_native_writer_result',
      { ...scope, expectedSnapshotHash: hash, result: { ...result,
        assessment: { reviewer: { kind: 'model', identity: 'synthetic unit writer' },
          assessments: [], answers: [], unsupportedClaims: [] } } }, invocation))
      .rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(mocks.action).not.toHaveBeenCalled()
    expect(registry().listTools().map((tool) => tool.name)).not.toContain(
      'torchiko.prospects.review_native_writer')
  })
})
