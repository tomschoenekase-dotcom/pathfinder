import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  heartbeatSession: vi.fn(),
  claim: vi.fn(),
  heartbeatTask: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  registerWorker: vi.fn(),
  heartbeatWorker: vi.fn(),
  listWorkers: vi.fn(),
  prospectCall: vi.fn(),
  operationalList: vi.fn(),
  operationalCall: vi.fn(),
  prepareCharacter: vi.fn(),
  readCharacterJob: vi.fn(),
  cancelCharacter: vi.fn(),
  claimCharacter: vi.fn(),
  heartbeatCharacter: vi.fn(),
  completeCharacter: vi.fn(),
  failCharacter: vi.fn(),
  submitCharacterReview: vi.fn(),
  readCharacterReview: vi.fn(),
  getVerifiedCharacterArtifact: vi.fn(),
}))
vi.mock('../prospect-agent/registry', () => ({
  createProspectAgentRegistry: () => ({ callTool: mocks.prospectCall }),
}))
vi.mock('@pathfinder/db', () => ({
  registerAgentBridgeSession: mocks.register,
  heartbeatAgentBridgeSession: mocks.heartbeatSession,
  claimAgentBridgeTask: mocks.claim,
  heartbeatAgentBridgeTask: mocks.heartbeatTask,
  completeAgentBridgeTask: mocks.complete,
  failAgentBridgeTask: mocks.fail,
  registerAgentWorkerAction: mocks.registerWorker,
  heartbeatAgentWorkerAction: mocks.heartbeatWorker,
  listAgentWorkerHealth: mocks.listWorkers,
  prepareCharacterFactoryJobAction: mocks.prepareCharacter,
  readCharacterFactoryJobAction: mocks.readCharacterJob,
  cancelCharacterFactoryJobAction: mocks.cancelCharacter,
  claimCharacterFactoryJobAction: mocks.claimCharacter,
  heartbeatCharacterFactoryJobAction: mocks.heartbeatCharacter,
  completeCharacterFactoryJobAction: mocks.completeCharacter,
  failCharacterFactoryJobAction: mocks.failCharacter,
  submitCharacterCandidateReviewBrief: mocks.submitCharacterReview,
  readCharacterCandidateReviewBrief: mocks.readCharacterReview,
}))
vi.mock('../lib/character-artifact-storage', () => ({
  beginCharacterArtifactUpload: vi.fn(),
  createCharacterArtifactStorage: () => ({ getVerified: mocks.getVerifiedCharacterArtifact }),
}))

import { createAgentBridgeRegistry } from './registry'

const credential = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: ['agent-runs:execute'],
} as const

describe('agent bridge registry', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards the exact optional foreground run without changing existing claim authority', async () => {
    mocks.claim.mockResolvedValue({ task: null })
    const registry = createAgentBridgeRegistry()
    const scope = { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', venueId: 'venue-1' }
    await registry.claimTask({ ...scope, runId: 'selected-run', workerKey: 'foreground-writer' }, { credential })
    expect(mocks.claim).toHaveBeenLastCalledWith({ ...scope, runId: 'selected-run',
      workerKey: 'foreground-writer', credential })
    await registry.claimTask(scope, { credential })
    expect(mocks.claim).toHaveBeenLastCalledWith({ ...scope, credential })
    expect(() => registry.claimTask({ ...scope, runId: ' ' }, { credential })).toThrow()
    expect(mocks.claim).toHaveBeenCalledTimes(2)
  })

  it('discovers character production only for an exact builder capability', () => {
    const registry = createAgentBridgeRegistry()
    expect(() => registry.listCharacterFactoryActions({}, { credential })).toThrow(
      /characters:build/u,
    )
    expect(
      registry.listCharacterFactoryActions(
        {},
        {
          credential: { ...credential, capabilities: ['characters:build'] },
        },
      ),
    ).toMatchObject({ capability: 'characters:build', actions: expect.arrayContaining(['EXPORT']) })
  })

  it('submits only a bounded agent review brief under the exact character-builder scope', async () => {
    mocks.submitCharacterReview.mockResolvedValue({ brief: { id: 'brief-1' }, replayed: false })
    const registry = createAgentBridgeRegistry()
    const input = {
      venueId: 'venue-1',
      characterId: 'character-1',
      brief: 'Review the imported candidate.',
      rationale: 'Check the existing fixture against the requested traits.',
      sourceProvenance: 'IMPORTED_FIXTURE' as const,
    }
    await expect(
      registry.submitCharacterCandidateReview(input, {
        credential: { ...credential, capabilities: ['characters:build'] },
      }),
    ).resolves.toMatchObject({ replayed: false })
    expect(mocks.submitCharacterReview).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      ...input,
      actor: { id: 'credential-1', role: 'AGENT', type: 'AGENT' },
    })
    expect(() =>
      registry.submitCharacterCandidateReview(
        { ...input, venueId: 'venue-2' },
        { credential: { ...credential, capabilities: ['characters:build'] } },
      ),
    ).toThrow(/exact tenant, venue/u)
    expect(() =>
      registry.submitCharacterCandidateReview(
        { ...input, decision: 'ACCEPT' },
        { credential: { ...credential, capabilities: ['characters:build'] } },
      ),
    ).toThrow()
  })

  it('reads only the scoped review snapshot and immutable decision/job receipt', async () => {
    mocks.readCharacterReview.mockResolvedValue({
      id: 'brief-1',
      brief: 'Review this imported candidate.',
      sourceProvenance: 'IMPORTED_FIXTURE',
      candidateVersion: 1,
      candidateRevision: 2,
      artifactFingerprint: 'a'.repeat(64),
      decision: {
        decision: 'REVISE',
        resultingJob: { id: 'job-1', action: 'REVISE', status: 'QUEUED' },
      },
    })
    const registry = createAgentBridgeRegistry()
    await expect(
      registry.readCharacterCandidateReview(
        { venueId: 'venue-1', briefId: 'brief-1' },
        { credential: { ...credential, capabilities: ['characters:build'] } },
      ),
    ).resolves.toMatchObject({
      id: 'brief-1',
      candidateVersion: 1,
      candidateRevision: 2,
      artifactFingerprint: 'a'.repeat(64),
      decision: { decision: 'REVISE', resultingJob: { id: 'job-1', action: 'REVISE' } },
    })
    expect(mocks.readCharacterReview).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      briefId: 'brief-1',
    })
    expect(() =>
      registry.readCharacterCandidateReview(
        { venueId: 'venue-2', briefId: 'brief-1' },
        { credential: { ...credential, capabilities: ['characters:build'] } },
      ),
    ).toThrow(/exact tenant, venue/u)
  })

  it('keeps character execution separate from builder authority and preserves machine identity', async () => {
    mocks.claimCharacter.mockResolvedValue({ state: 'claimed' })
    const registry = createAgentBridgeRegistry()
    const params = {
      venueId: 'venue-1',
      requestId: 'request-1',
    }
    expect(() =>
      registry.claimCharacterFactoryJob(params, {
        credential: { ...credential, capabilities: ['characters:build'] },
      }),
    ).toThrow(/characters:execute/u)
    const executor = { ...credential, capabilities: ['characters:execute'] as const }
    await registry.claimCharacterFactoryJob(params, { credential: executor })
    expect(mocks.claimCharacter).toHaveBeenCalledWith({ tenantId: 'tenant-1', ...params })
    expect(() =>
      registry.beginCharacterArtifactUpload(
        {
          venueId: 'venue-1',
          characterId: 'character-1',
          characterVersion: 1,
          sha256: '0'.repeat(64),
          byteLength: 100,
        },
        { credential: { ...credential, capabilities: ['characters:build'] } },
      ),
    ).toThrow(/characters:execute/u)
  })

  it('preserves a verified runtime pack at the executor completion boundary', async () => {
    const runtimePack = { renderer: 'family-rig-v1', characterId: 'tochi' }
    mocks.getVerifiedCharacterArtifact.mockResolvedValue({
      reference: { kind: 'character-bundle-v1' },
      spec: { characterId: 'tochi', version: 1 },
      runtimePack,
    })
    mocks.completeCharacter.mockImplementation(
      async (
        input: Record<string, unknown>,
        _client: unknown,
        options: {
          verifyArtifact: (input: {
            tenantId: unknown
            venueId: unknown
            reference: unknown
            expectedSpec: unknown
          }) => Promise<unknown>
        },
      ) =>
        options.verifyArtifact({
          tenantId: input.tenantId,
          venueId: input.venueId,
          reference: input.assetStorageReference,
          expectedSpec: input.characterSpec,
        }),
    )

    await expect(
      createAgentBridgeRegistry().completeCharacterFactoryJob(
        {
          venueId: 'venue-1',
          requestId: 'export-tochi-1',
          leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          resultPayload: {},
          characterSpec: { characterId: 'tochi', version: 1 },
          assetStorageReference: { kind: 'character-bundle-v1' },
        },
        { credential: { ...credential, capabilities: ['characters:execute'] } },
      ),
    ).resolves.toMatchObject({ runtimePack })
  })

  it('validates bounded runner metadata before registering a session', async () => {
    mocks.register.mockResolvedValue({ id: 'session' })
    const registry = createAgentBridgeRegistry()
    await registry.register(
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        venueId: 'venue-1',
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Tom desktop Codex',
        runnerVersion: '1.0.0',
        supportedModels: ['subscription-default'],
      },
      { credential },
    )
    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX_SUBSCRIPTION',
        credential,
      }),
    )
    expect(() =>
      registry.register(
        {
          sessionId: 'not-a-uuid',
          venueId: 'venue-1',
          provider: 'CODEX_SUBSCRIPTION',
          label: 'runner',
          runnerVersion: '1',
          supportedModels: [],
        },
        { credential },
      ),
    ).toThrow()
  })

  it('registers a provider-neutral worker under the verified machine credential', async () => {
    mocks.registerWorker.mockResolvedValue({ id: 'worker-id-1', status: 'ONLINE' })
    const workerCredential = {
      ...credential,
      capabilities: ['agent-runs:execute', 'updates:draft', 'workers:read'],
    }
    const registry = createAgentBridgeRegistry()
    await registry.registerWorker(
      {
        workerKey: 'secondary-admin-hermes-1',
        runtimeType: 'HERMES',
        label: 'Secondary admin worker',
        protocolVersion: '1.0',
        softwareVersion: '2.4.1',
        capabilities: ['agent-runs:execute', 'updates:draft'],
        agentRoles: ['client-operations'],
        modelProvider: 'nous',
        modelName: 'deepseek-v4-flash',
        safeHealth: { queueDepth: 0 },
      },
      { credential: workerCredential },
    )
    expect(mocks.registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        workerKey: 'secondary-admin-hermes-1',
        runtimeType: 'HERMES',
        capabilities: ['agent-runs:execute', 'updates:draft'],
      }),
      workerCredential,
    )
  })

  it('binds a claimed run to an optional portable worker and protects worker health discovery', async () => {
    mocks.claim.mockResolvedValue({ task: { id: 'run-1' } })
    mocks.listWorkers.mockResolvedValue([{ workerKey: 'worker-1', status: 'ONLINE' }])
    const workerCredential = {
      ...credential,
      capabilities: ['agent-runs:execute', 'workers:read'],
    }
    const registry = createAgentBridgeRegistry()
    await registry.claimTask(
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        venueId: 'venue-1',
        workerKey: 'worker-1',
      },
      { credential: workerCredential },
    )
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ workerKey: 'worker-1', credential: workerCredential }),
    )
    expect(() => registry.listWorkers({}, { credential })).toThrow(/workers:read/u)
    await expect(registry.listWorkers({}, { credential: workerCredential })).resolves.toEqual([
      { workerKey: 'worker-1', status: 'ONLINE' },
    ])
  })

  it('parses decimal cost units to bigint and bounds bridge artifacts', async () => {
    mocks.complete.mockResolvedValue({ status: 'COMPLETED' })
    await createAgentBridgeRegistry().completeTask(
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        venueId: 'venue-1',
        runId: 'run-1',
        leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        summary: 'Done',
        artifacts: [{ type: 'markdown', title: 'Result', content: 'Evidence' }],
        modelName: 'subscription-default',
        costE8Usd: '1250',
        costStatus: 'ESTIMATED',
      },
      { credential },
    )
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ costE8Usd: 1250n, costStatus: 'ESTIMATED' }),
    )
  })

  it('rejects unknown task failure codes before calling the database boundary', async () => {
    const registry = createAgentBridgeRegistry()

    expect(() =>
      registry.failTask(
        {
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          venueId: 'venue-1',
          runId: 'run-1',
          leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          errorCode: 'UPSTREAM_SECRET_TOKEN',
          retryable: true,
        },
        { credential },
      ),
    ).toThrow()
    expect(mocks.fail).not.toHaveBeenCalled()
  })

  it('mounts prospect tools through the authenticated bridge and derives authority fields', async () => {
    mocks.prospectCall.mockResolvedValue({ id: 'draft-1' })
    const result = await createAgentBridgeRegistry().callProspectTool(
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        venueId: 'venue-1',
        runId: 'run-1',
        leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        toolName: 'torchiko.prospects.save_outreach_draft',
        arguments: { subject: 'Hello' },
      },
      { credential },
    )
    expect(result).toEqual({ id: 'draft-1' })
    expect(mocks.prospectCall).toHaveBeenCalledWith(
      'torchiko.prospects.save_outreach_draft',
      { subject: 'Hello' },
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        agentRunId: 'run-1',
        leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        credentialId: 'credential-1',
        correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
    )
  })

  it('mounts operational discovery and derives client and venue scope from the credential', async () => {
    mocks.operationalList.mockReturnValue([
      {
        name: 'pathfinder.read',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
        _meta: {
          'com.pathfinder/security': { capability: 'resources:read', scope: 'client-or-venue' },
        },
      },
      {
        name: 'pathfinder.create_update_draft',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false },
        _meta: { 'com.pathfinder/security': { capability: 'updates:draft', scope: 'venue' } },
      },
    ])
    mocks.operationalCall.mockResolvedValue({ structuredContent: { kind: 'pathfinder.read' } })
    const registry = createAgentBridgeRegistry({
      operationalRegistry: {
        listTools: mocks.operationalList,
        callTool: mocks.operationalCall,
      } as never,
    })
    const discoveryCredential = {
      ...credential,
      capabilities: ['agent-runs:execute', 'resources:read'],
    }
    expect(registry.listOperationalTools({}, { credential: discoveryCredential })).toEqual([
      expect.objectContaining({
        name: 'pathfinder.read',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
        _meta: {
          'com.pathfinder/security': { capability: 'resources:read', scope: 'client-or-venue' },
        },
      }),
    ])
    await registry.callOperationalTool(
      {
        venueId: 'venue-1',
        toolName: 'pathfinder.read',
        arguments: { clientId: 'spoofed', venueId: 'spoofed', resource: 'venues' },
      },
      { credential },
    )
    expect(mocks.operationalCall).toHaveBeenCalledWith(
      'pathfinder.read',
      { clientId: 'tenant-1', venueId: 'venue-1', resource: 'venues' },
      { credential },
    )
  })

  it('rejects operational calls outside exact credential venue scope', async () => {
    expect(() =>
      createAgentBridgeRegistry({
        operationalRegistry: { listTools: vi.fn(), callTool: mocks.operationalCall } as never,
      }).callOperationalTool(
        { venueId: 'venue-2', toolName: 'pathfinder.read', arguments: {} },
        { credential },
      ),
    ).toThrow(/exact credential venue scope/u)
    expect(mocks.operationalCall).not.toHaveBeenCalled()
  })

  it('forwards outer execution claim keys with authenticated scope for source admission', async () => {
    const executionClaim = {
      agentRunId: 'run-1',
      bridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workerId: 'worker-1',
      executionLeaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }
    const registry = createAgentBridgeRegistry({
      operationalRegistry: { listTools: vi.fn(), callTool: mocks.operationalCall } as never,
    })
    await registry.callOperationalTool(
      {
        venueId: 'venue-1',
        toolName: 'pathfinder.read',
        executionClaim,
        arguments: {
          resource: 'question-source',
          agentRunId: 'run-1',
          questionId: 'question-1',
          clientId: 'spoofed',
        },
      },
      { credential },
    )
    expect(mocks.operationalCall).toHaveBeenCalledWith(
      'pathfinder.read',
      {
        resource: 'question-source',
        agentRunId: 'run-1',
        questionId: 'question-1',
        clientId: 'tenant-1',
        venueId: 'venue-1',
      },
      { credential, executionClaim },
    )
  })

  it('does not derive source execution authority from arbitrary arguments or raw context', () => {
    const registry = createAgentBridgeRegistry({
      operationalRegistry: { listTools: vi.fn(), callTool: mocks.operationalCall } as never,
    })
    expect(() =>
      registry.callOperationalTool(
        {
          venueId: 'venue-1',
          toolName: 'pathfinder.read',
          arguments: { resource: 'question-source', agentRunId: 'run-1', executionClaim: {} },
        },
        { credential, executionClaim: {} },
      ),
    ).toThrow(/exact worker execution claim/u)
    expect(mocks.operationalCall).not.toHaveBeenCalled()
  })
  it('forwards source-question claims and rejects absent or mismatched run claims', async () => {
    const registry = createAgentBridgeRegistry({
      operationalRegistry: { listTools: vi.fn(), callTool: mocks.operationalCall } as never,
    })
    const executionClaim = {
      agentRunId: 'run-1',
      bridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workerId: 'worker-1',
      executionLeaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }
    const args = { agentRunId: 'run-1', sourceClarification: { runId: 'intake-run-1' } }
    await registry.callOperationalTool(
      { venueId: 'venue-1', toolName: 'pathfinder.ask_operator', arguments: args, executionClaim },
      { credential },
    )
    expect(mocks.operationalCall).toHaveBeenCalledWith(
      'pathfinder.ask_operator',
      { ...args, venueId: 'venue-1', clientId: 'tenant-1' },
      { credential, executionClaim },
    )
    for (const claim of [undefined, { ...executionClaim, agentRunId: 'other-run' }]) {
      expect(() =>
        registry.callOperationalTool(
          {
            venueId: 'venue-1',
            toolName: 'pathfinder.ask_operator',
            arguments: args,
            executionClaim: claim,
          },
          { credential },
        ),
      ).toThrow(/exact worker execution claim/u)
    }
  })

  it('forwards source-resolution claims and rejects absent or mismatched run claims', async () => {
    const registry = createAgentBridgeRegistry({
      operationalRegistry: { listTools: vi.fn(), callTool: mocks.operationalCall } as never,
    })
    const executionClaim = {
      agentRunId: 'run-1',
      bridgeSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workerId: 'worker-1',
      executionLeaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }
    const args = { agentRunId: 'run-1', requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
    await registry.callOperationalTool(
      {
        venueId: 'venue-1',
        toolName: 'pathfinder.resolve_source_clarification',
        arguments: args,
        executionClaim,
      },
      { credential },
    )
    expect(mocks.operationalCall).toHaveBeenCalledWith(
      'pathfinder.resolve_source_clarification',
      { ...args, venueId: 'venue-1', clientId: 'tenant-1' },
      { credential, executionClaim },
    )
    for (const claim of [undefined, { ...executionClaim, agentRunId: 'other-run' }]) {
      expect(() =>
        registry.callOperationalTool(
          {
            venueId: 'venue-1',
            toolName: 'pathfinder.resolve_source_clarification',
            arguments: args,
            executionClaim: claim,
          },
          { credential },
        ),
      ).toThrow(/exact worker execution claim/u)
    }
  })
})
