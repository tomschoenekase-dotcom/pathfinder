import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentRunFindFirst: vi.fn(),
  organizationFindMany: vi.fn(),
  organizationFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  saveDraft: vi.fn(),
  askQuestion: vi.fn(),
  claimResearch: vi.fn(),
  finishResearch: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    agentRun: { findFirst: mocks.agentRunFindFirst },
    prospectOrganization: {
      findMany: mocks.organizationFindMany,
      findFirst: mocks.organizationFindFirst,
    },
    prospectCampaignMember: {
      findMany: mocks.memberFindMany,
      findFirst: mocks.memberFindFirst,
    },
    venue: { findFirst: vi.fn() },
    place: { findMany: vi.fn() },
    venueKnowledgeEntry: { findMany: vi.fn() },
  },
  withTenantIsolationBypass: (operation: () => unknown) => operation(),
  saveProspectOutreachDraftAction: mocks.saveDraft,
  askAgentQuestionAction: mocks.askQuestion,
  claimNextProspectResearchJobAction: mocks.claimResearch,
  finishProspectResearchJobAction: mocks.finishResearch,
}))

import {
  createProspectAgentRegistry,
  ProspectAgentRegistryError,
  resolveVerifiedProspectAgentContext,
  type ProspectAgentInvocation,
  type VerifiedProspectAgentContext,
} from './registry'

const invocation: ProspectAgentInvocation = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  agentRunId: 'run-1',
  leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  credentialId: 'credential-1',
  correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
}

function context(
  overrides: Partial<VerifiedProspectAgentContext> = {},
): VerifiedProspectAgentContext {
  return {
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    agentRunId: 'run-1',
    actorId: 'agent-1',
    initiatorId: 'admin-1',
    capabilities: ['prospects.read'],
    scope: { mode: 'ALL' },
    modelProvider: 'codex-bridge',
    modelName: 'gpt-test',
    promptIdentity: 'crm-playbook@1',
    requestedOperation: 'operator_task',
    correlationId: invocation.correlationId,
    ...overrides,
  }
}

describe('prospect agent registry', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes advisory, read, draft, and question tools but no high-risk authority', () => {
    const tools = createProspectAgentRegistry().listTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toContain('torchiko.prospects.save_outreach_draft')
    expect(names).toContain('torchiko.prospects.ask_operator')
    expect(
      names.some((name) => /approve|send|queue|convert|merge|delete|unsuppress/u.test(name)),
    ).toBe(false)
    expect(
      tools.every(
        (tool) =>
          tool.title &&
          tool.description &&
          ['read', 'draft', 'interaction', 'execute'].includes(tool.effect) &&
          typeof tool.idempotent === 'boolean' &&
          typeof tool.humanReviewRequired === 'boolean',
      ),
    ).toBe(true)
    expect(
      tools.every(
        (tool) =>
          tool.inputSchema.type === 'object' &&
          tool.inputSchema.additionalProperties === false &&
          tool.outputSchema &&
          tool.examples.length > 0 &&
          tool.relatedTools.length > 0,
      ),
    ).toBe(true)
    const nameSet = new Set<string>(names)
    expect(tools.flatMap((tool) => tool.relatedTools).every((name) => nameSet.has(name))).toBe(true)
  })

  it('rejects caller capability escalation because authority comes from the resolver', async () => {
    const registry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(context({ capabilities: ['prospects.read'] })),
    })
    await expect(
      registry.callTool('torchiko.prospects.save_outreach_draft', {}, invocation),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_REQUIRED',
    } satisfies Partial<ProspectAgentRegistryError>)
    expect(mocks.saveDraft).not.toHaveBeenCalled()
  })

  it('intersects live identity capabilities with the frozen AgentRun snapshot', async () => {
    mocks.agentRunFindFirst.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      initiatedById: 'admin-1',
      requestedOperation: 'operator_task',
      scopeSnapshot: {
        accessCapabilities: ['prospects.read', 'prospects.draft'],
        prospectScope: { mode: 'ALL' },
        promptIdentity: 'crm-playbook@1',
      },
      modelProvider: 'codex-bridge',
      modelName: 'gpt-test',
      agentIdentity: { id: 'agent-1', accessCapabilities: ['prospects.read'] },
    })
    const verified = await resolveVerifiedProspectAgentContext(invocation)
    expect(verified.capabilities).toEqual(['prospects.read'])
    expect(mocks.agentRunFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          executionLeaseToken: invocation.leaseToken,
          executionBridgeSessionId: invocation.sessionId,
        }),
      }),
    )
  })

  it('fails closed when a leased run has no explicit prospect scope', async () => {
    mocks.agentRunFindFirst.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      initiatedById: 'admin-1',
      requestedOperation: 'operator_task',
      scopeSnapshot: { accessCapabilities: ['prospects.read'] },
      modelProvider: null,
      modelName: null,
      agentIdentity: { id: 'agent-1', accessCapabilities: ['prospects.read'] },
    })
    await expect(resolveVerifiedProspectAgentContext(invocation)).rejects.toMatchObject({
      code: 'SCOPE_REQUIRED',
    })
  })

  it('enforces frozen territory scope on reads and draft membership', async () => {
    mocks.organizationFindMany.mockResolvedValue([])
    const scoped = context({
      capabilities: ['prospects.read', 'prospects.draft'],
      scope: { mode: 'TERRITORIES', territoryIds: ['territory-1'] },
    })
    const registry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(scoped),
    })
    await registry.callTool('torchiko.prospects.search', {}, invocation)
    expect(mocks.organizationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ territoryId: { in: ['territory-1'] } }),
      }),
    )

    mocks.memberFindFirst.mockResolvedValue(null)
    await expect(
      registry.callTool(
        'torchiko.prospects.save_outreach_draft',
        {
          memberId: 'member-outside-scope',
          subject: 'Hello',
          textBody: 'Body',
          evidence: [{ kind: 'CRM_FIELD', reference: 'prospect.name' }],
          template: { id: 'intro', version: '1' },
          prompt: { id: 'draft', version: '1' },
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(mocks.saveDraft).not.toHaveBeenCalled()
  })

  it('stores verified run/model/prompt/evidence lineage on a grounded draft', async () => {
    mocks.memberFindFirst.mockResolvedValue({ id: 'member-1' })
    mocks.saveDraft.mockResolvedValue({ id: 'draft-1' })
    const registry = createProspectAgentRegistry({
      resolveContext: vi
        .fn()
        .mockResolvedValue(context({ capabilities: ['prospects.read', 'prospects.draft'] })),
    })
    await registry.callTool(
      'torchiko.prospects.save_outreach_draft',
      {
        memberId: 'member-1',
        subject: 'Hello',
        textBody: 'Body',
        evidence: [{ kind: 'SOURCE_EVIDENCE', reference: 'source-1', summary: 'Verified fact' }],
        template: { id: 'intro', version: '1' },
        prompt: { id: 'draft', version: '2' },
      },
      invocation,
    )
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'AGENT', id: 'agent-1', capabilities: ['prospects:draft'] },
        groundingSnapshot: expect.objectContaining({
          evidence: [
            {
              kind: 'SOURCE_EVIDENCE',
              reference: 'source-1',
              summary: 'Verified fact',
              trust: 'UNTRUSTED_EXTERNAL_EVIDENCE',
            },
          ],
          lineage: expect.objectContaining({
            agentRunId: 'run-1',
            agentIdentityId: 'agent-1',
            modelName: 'gpt-test',
            correlationId: invocation.correlationId,
          }),
        }),
      }),
    )
  })

  it('claims and completes only through frozen research authority and scope', async () => {
    mocks.claimResearch.mockResolvedValue({ jobId: 'job-1', claimToken: invocation.leaseToken })
    mocks.finishResearch.mockResolvedValue({ id: 'job-1', status: 'CAP_REACHED' })
    const registry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(
        context({
          capabilities: ['prospects.research'],
          scope: { mode: 'TERRITORIES', territoryIds: ['territory-1'] },
        }),
      ),
    })
    await registry.callTool(
      'torchiko.prospects.claim_research_job',
      { leaseSeconds: 300 },
      invocation,
    )
    expect(mocks.claimResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          agentRunId: 'run-1',
          agentIdentityId: 'agent-1',
          territoryIds: ['territory-1'],
          promptIdentity: 'crm-playbook@1',
        }),
      }),
    )
    await registry.callTool(
      'torchiko.prospects.complete_research_job',
      {
        claimToken: invocation.leaseToken,
        outcome: 'CAP_REACHED',
        reason: 'No official contact found within the bounded cap',
        usage: { searches: 4 },
      },
      invocation,
    )
    expect(mocks.finishResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'CAP_REACHED',
        context: expect.objectContaining({ agentRunId: 'run-1' }),
      }),
    )
  })

  it('creates a scoped Agent Question without granting approval authority', async () => {
    mocks.askQuestion.mockResolvedValue({ question: { id: 'question-1' } })
    const registry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(context({ capabilities: ['prospects.question'] })),
    })
    await registry.callTool(
      'torchiko.prospects.ask_operator',
      {
        operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        question: 'Which contact should I draft for?',
        evidence: [{ kind: 'CRM_FIELD', reference: 'contact:ambiguous' }],
      },
      invocation,
    )
    expect(mocks.askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        agentRunId: 'run-1',
        category: 'prospect-crm',
      }),
    )
  })

  it('rejects unknown and forbidden high-risk tool names before resolving authority', async () => {
    const resolveContext = vi.fn()
    await expect(
      createProspectAgentRegistry({ resolveContext }).callTool(
        'torchiko.prospects.send',
        {},
        invocation,
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' } satisfies Partial<ProspectAgentRegistryError>)
    expect(resolveContext).not.toHaveBeenCalled()
  })
})
