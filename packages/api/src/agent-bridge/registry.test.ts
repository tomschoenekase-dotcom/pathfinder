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
})
