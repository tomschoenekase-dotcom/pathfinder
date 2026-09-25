import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentRunFindFirst: vi.fn(),
  organizationFindMany: vi.fn(),
  organizationFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  draftFindFirst: vi.fn(),
  knowledgeFindFirst: vi.fn(),
  saveDraft: vi.fn(),
  askQuestion: vi.fn(),
  claimResearch: vi.fn(),
  finishResearch: vi.fn(),
  prospectVenueFindFirst: vi.fn(),
  launchAssetView: vi.fn(),
  selectLaunchAsset: vi.fn(),
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
    prospectOutreachDraft: { findFirst: mocks.draftFindFirst },
    prospectVenue: { findFirst: mocks.prospectVenueFindFirst },
    companyKnowledgeItem: { findFirst: mocks.knowledgeFindFirst },
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
vi.mock('../prospect-launch-assets', () => ({
  prospectLaunchAssetView: mocks.launchAssetView,
  selectProspectLaunchAsset: mocks.selectLaunchAsset,
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
    expect(names).toContain('torchiko.prospects.list_launch_assets')
    expect(names).toContain('torchiko.prospects.select_launch_asset')
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

  it('scopes launch asset listing and selection to an in-scope prospect venue and returns descriptors only', async () => {
    mocks.prospectVenueFindFirst.mockResolvedValue({ id: 'prospect-venue-1' })
    const asset = {
      schema: 'torchiko.venue-launch-asset/2',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      release: { kind: 'NATIVE', id: 'release-1', revisionSha256: 'a'.repeat(64) },
      publicUrl: 'https://guide.example.com/venue/chat?source=qr',
      filename: 'venue-qr.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      sha256: 'b'.repeat(64),
      format: 'PNG',
      generatorVersion: 'qr-print-v1',
    }
    mocks.launchAssetView.mockResolvedValue({ available: [asset], hold: null })
    mocks.selectLaunchAsset.mockResolvedValue({ ...asset, contentBase64: 'not-for-tool-output' })
    const registry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(context()),
    })
    await expect(
      registry.callTool(
        'torchiko.prospects.list_launch_assets',
        {
          organizationId: 'org-1',
          prospectVenueId: 'prospect-venue-1',
        },
        invocation,
      ),
    ).resolves.toEqual({ available: [asset], hold: null })
    expect(mocks.prospectVenueFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'prospect-venue-1',
          organizationId: 'org-1',
          archivedAt: null,
        }),
      }),
    )
    await expect(
      registry.callTool(
        'torchiko.prospects.select_launch_asset',
        {
          organizationId: 'org-1',
          prospectVenueId: 'prospect-venue-1',
          selection: {
            tenantId: 'tenant-1',
            venueId: 'venue-1',
            release: asset.release,
            publicUrl: asset.publicUrl,
            sha256: asset.sha256,
            format: 'PNG',
            generatorVersion: 'qr-print-v1',
          },
        },
        invocation,
      ),
    ).resolves.toEqual(asset)
    expect(mocks.selectLaunchAsset).toHaveBeenCalledWith(
      'prospect-venue-1',
      expect.objectContaining({
        format: 'PNG',
        generatorVersion: 'qr-print-v1',
      }),
    )
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

  it('accepts evidence IDs and rejects caller-supplied resolved evidence fields', async () => {
    mocks.memberFindFirst.mockResolvedValue({ id: 'member-1', venueId: 'venue-1' })
    mocks.saveDraft.mockResolvedValue({ id: 'draft-1', status: 'NEEDS_REVIEW', version: 1 })
    const registry = createProspectAgentRegistry({
      resolveContext: vi
        .fn()
        .mockResolvedValue(context({ capabilities: ['prospects.read', 'prospects.draft'] })),
    })
    const input = {
      memberId: 'member-1',
      subject: 'Hello',
      textBody: 'Body',
      evidence: [{ kind: 'CRM_FIELD', reference: 'prospect.name' }],
      sourceEvidenceIds: ['source-1'],
      template: { id: 'intro', version: '1' },
      prompt: { id: 'draft', version: '1' },
    }
    await registry.callTool('torchiko.prospects.save_outreach_draft', input, invocation)
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEvidenceIds: ['source-1'],
        groundingSnapshot: expect.objectContaining({
          evidence: [expect.objectContaining({ kind: 'CRM_FIELD', trust: 'CANONICAL_CRM_DATA' })],
        }),
      }),
    )

    await expect(
      registry.callTool(
        'torchiko.prospects.save_outreach_draft',
        {
          ...input,
          resolvedSourceEvidence: [{ id: 'source-1', sourceUrl: 'https://attacker.invalid' }],
        },
        invocation,
      ),
    ).rejects.toThrow()
  })

  it('reads one exact scoped draft version and its frozen review evidence without review authority', async () => {
    const saved = {
      id: 'draft-1',
      memberId: 'member-1',
      version: 2,
      status: 'NEEDS_REVIEW',
      contentHash: 'a'.repeat(64),
      groundingSnapshot: { resolvedSourceEvidence: [{ id: 'source-1', sha256: 'b'.repeat(64) }] },
      generatedByType: 'AGENT',
      generatedById: 'agent-1',
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
      createdAt: new Date('2026-09-25T00:00:00.000Z'),
    }
    mocks.draftFindFirst.mockResolvedValue(saved)
    const registry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(
        context({ scope: { mode: 'TERRITORIES', territoryIds: ['territory-1'] } }),
      ),
    })
    await expect(
      registry.callTool(
        'torchiko.prospects.get_outreach_draft',
        { memberId: 'member-1', draftId: 'draft-1' },
        invocation,
      ),
    ).resolves.toEqual(saved)
    expect(mocks.draftFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'draft-1',
          memberId: 'member-1',
          organization: { territoryId: { in: ['territory-1'] } },
        },
        select: expect.objectContaining({ groundingSnapshot: true, status: true }),
      }),
    )
    expect(mocks.saveDraft).not.toHaveBeenCalled()
  })

  it('requires read capability and rejects caller-supplied review authority', async () => {
    const registry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(context({ capabilities: ['prospects.draft'] })),
    })
    await expect(
      registry.callTool(
        'torchiko.prospects.get_outreach_draft',
        { memberId: 'member-1', draftId: 'draft-1' },
        invocation,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' })
    expect(mocks.draftFindFirst).not.toHaveBeenCalled()

    const readRegistry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(context()),
    })
    await expect(
      readRegistry.callTool(
        'torchiko.prospects.get_outreach_draft',
        { memberId: 'member-1', draftId: 'draft-1', approve: true },
        invocation,
      ),
    ).rejects.toThrow()
    expect(mocks.draftFindFirst).not.toHaveBeenCalled()
  })

  it('resolves an optional QR selection server-side and stores verified PDF proof without returning bytes', async () => {
    const asset = {
      schema: 'torchiko.venue-launch-asset/2',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      release: { kind: 'NATIVE', id: 'release-1', revisionSha256: 'a'.repeat(64) },
      publicUrl: 'https://guide.example.com/venue/chat?source=qr',
      filename: 'venue-qr.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      sha256: 'b'.repeat(64),
      format: 'PDF',
      generatorVersion: 'qr-print-v1',
      contentBase64: 'JVBERi0xLjQK',
    } as const
    const selection = {
      tenantId: asset.tenantId,
      venueId: asset.venueId,
      release: asset.release,
      publicUrl: asset.publicUrl,
      sha256: asset.sha256,
      format: 'PDF',
      generatorVersion: 'qr-print-v1',
    } as const
    mocks.memberFindFirst.mockResolvedValue({ id: 'member-1', venueId: 'prospect-venue-1' })
    mocks.selectLaunchAsset.mockResolvedValue(asset)
    mocks.saveDraft.mockResolvedValue({ id: 'draft-1', status: 'NEEDS_REVIEW', version: 1 })
    const registry = createProspectAgentRegistry({
      resolveContext: vi
        .fn()
        .mockResolvedValue(context({ capabilities: ['prospects.read', 'prospects.draft'] })),
    })
    const output = await registry.callTool(
      'torchiko.prospects.save_outreach_draft',
      {
        memberId: 'member-1',
        subject: 'Hello',
        textBody: 'Body',
        evidence: [{ kind: 'CRM_FIELD', reference: 'prospect.name' }],
        template: { id: 'intro', version: '1' },
        prompt: { id: 'draft', version: '1' },
        launchAssetSelection: selection,
      },
      invocation,
    )
    expect(output).toEqual({ id: 'draft-1', status: 'NEEDS_REVIEW', version: 1 })
    expect(mocks.selectLaunchAsset).toHaveBeenCalledWith('prospect-venue-1', selection)
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        groundingSnapshot: expect.objectContaining({ launchAttachments: [asset] }),
        verifiedCurrentPrintAssets: [{ prospectVenueId: 'prospect-venue-1', asset }],
      }),
    )
    expect(JSON.stringify(mocks.saveDraft.mock.calls[0]?.[0])).toContain(asset.contentBase64)
    expect(JSON.stringify(output)).not.toContain(asset.contentBase64)
  })

  it('rejects caller-supplied attachment bytes on the agent draft tool', async () => {
    const registry = createProspectAgentRegistry({
      resolveContext: vi
        .fn()
        .mockResolvedValue(context({ capabilities: ['prospects.read', 'prospects.draft'] })),
    })
    await expect(
      registry.callTool(
        'torchiko.prospects.save_outreach_draft',
        {
          memberId: 'member-1',
          subject: 'Hello',
          textBody: 'Body',
          evidence: [{ kind: 'CRM_FIELD', reference: 'prospect.name' }],
          template: { id: 'intro', version: '1' },
          prompt: { id: 'draft', version: '1' },
          launchAttachments: [{ contentBase64: 'arbitrary' }],
        },
        invocation,
      ),
    ).rejects.toThrow()
    expect(mocks.saveDraft).not.toHaveBeenCalled()
  })

  it('resolves approved copy identity from current platform knowledge instead of caller assertions', async () => {
    mocks.memberFindFirst.mockResolvedValue({ id: 'member-1' })
    mocks.knowledgeFindFirst.mockResolvedValue({
      id: 'copy-1',
      currentRevision: 3,
      promotionStatus: 'PROMOTED',
      revisions: [{ sourceDigest: 'a'.repeat(64), structuredData: { allowedUses: ['OUTREACH'] } }],
    })
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
        textBody: 'A grounded introduction.',
        evidence: [{ kind: 'CRM_FIELD', reference: 'prospect.name' }],
        template: { id: 'intro', version: '1' },
        prompt: { id: 'draft', version: '1' },
        copySources: [{ id: 'copy-1', version: '3' }],
      },
      invocation,
    )
    expect(mocks.knowledgeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'copy-1',
          currentRevision: 3,
          OR: [
            { promotionStatus: 'PROMOTED', authority: 'AUTHORITATIVE_CURRENT' },
            {
              promotionStatus: 'CANDIDATE',
              authority: { in: ['DURABLE_CONTEXT', 'INFERENCE'] },
            },
          ],
        }),
      }),
    )
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        groundingSnapshot: expect.objectContaining({
          copyHandoff: expect.objectContaining({
            copySources: [
              expect.objectContaining({
                provenance: 'a'.repeat(64),
                status: 'APPROVED',
              }),
            ],
            warnings: [],
            reviewRequired: true,
            sendAuthorized: false,
          }),
        }),
      }),
    )
  })

  it('resolves an exact current canonical candidate as proposed review-only copy', async () => {
    mocks.memberFindFirst.mockResolvedValue({ id: 'member-1' })
    mocks.knowledgeFindFirst.mockResolvedValue({
      id: 'copy-proposed',
      currentRevision: 1,
      promotionStatus: 'CANDIDATE',
      revisions: [{ sourceDigest: 'b'.repeat(64), structuredData: { allowedUses: ['OUTREACH'] } }],
    })
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
        textBody: 'A proposed introduction.',
        evidence: [{ kind: 'CRM_FIELD', reference: 'prospect.name' }],
        template: { id: 'intro', version: '1' },
        prompt: { id: 'draft', version: '1' },
        copySources: [{ id: 'copy-proposed', version: '1' }],
      },
      invocation,
    )

    expect(mocks.knowledgeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'copy-proposed',
          accessScope: 'PLATFORM',
          type: 'POLICY_CONTEXT',
          OR: [
            { promotionStatus: 'PROMOTED', authority: 'AUTHORITATIVE_CURRENT' },
            {
              promotionStatus: 'CANDIDATE',
              authority: { in: ['DURABLE_CONTEXT', 'INFERENCE'] },
            },
          ],
          currentRevision: 1,
          archivedAt: null,
          supersededAt: null,
        }),
      }),
    )
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        groundingSnapshot: expect.objectContaining({
          copyHandoff: expect.objectContaining({
            copySources: [
              expect.objectContaining({
                id: 'copy-proposed',
                version: '1',
                status: 'PROPOSED',
                provenance: 'b'.repeat(64),
              }),
            ],
            warnings: ['Draft uses proposed copy that still needs founder approval.'],
            reviewRequired: true,
            sendAuthorized: false,
          }),
        }),
      }),
    )
  })

  it('rejects a canonical candidate without outreach use before saving', async () => {
    mocks.knowledgeFindFirst.mockResolvedValue({
      id: 'copy-proposed',
      currentRevision: 2,
      promotionStatus: 'CANDIDATE',
      revisions: [{ sourceDigest: 'c'.repeat(64), structuredData: { allowedUses: ['PROPOSAL'] } }],
    })
    const registry = createProspectAgentRegistry({
      resolveContext: vi
        .fn()
        .mockResolvedValue(context({ capabilities: ['prospects.read', 'prospects.draft'] })),
    })
    await expect(
      registry.callTool(
        'torchiko.prospects.save_outreach_draft',
        {
          memberId: 'member-1',
          subject: 'Hello',
          textBody: 'A grounded introduction.',
          evidence: [{ kind: 'CRM_FIELD', reference: 'prospect.name' }],
          template: { id: 'intro', version: '1' },
          prompt: { id: 'draft', version: '1' },
          copySources: [{ id: 'copy-1', version: '2' }],
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(mocks.saveDraft).not.toHaveBeenCalled()
  })

  it('rejects a stale or ineligible copy-bank reference before saving a draft', async () => {
    mocks.knowledgeFindFirst.mockResolvedValue(null)
    const registry = createProspectAgentRegistry({
      resolveContext: vi
        .fn()
        .mockResolvedValue(context({ capabilities: ['prospects.read', 'prospects.draft'] })),
    })
    await expect(
      registry.callTool(
        'torchiko.prospects.save_outreach_draft',
        {
          memberId: 'member-1',
          subject: 'Hello',
          textBody: 'A grounded introduction.',
          evidence: [{ kind: 'CRM_FIELD', reference: 'prospect.name' }],
          template: { id: 'intro', version: '1' },
          prompt: { id: 'draft', version: '1' },
          copySources: [{ id: 'copy-1', version: '2' }],
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
    expect(mocks.saveDraft).not.toHaveBeenCalled()
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
        expiresAt: '2030-01-01T18:00:00.000Z',
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
        expiresAt: new Date('2030-01-01T18:00:00.000Z'),
      }),
    )
  })

  it('keeps legacy operator questions without an expiry compatible', async () => {
    mocks.askQuestion.mockResolvedValue({ question: { id: 'question-1' } })
    const registry = createProspectAgentRegistry({
      resolveContext: vi.fn().mockResolvedValue(context({ capabilities: ['prospects.question'] })),
    })
    await registry.callTool(
      'torchiko.prospects.ask_operator',
      {
        operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        question: 'Which contact should I draft for?',
      },
      invocation,
    )
    expect(mocks.askQuestion.mock.calls[0]?.[0]).not.toHaveProperty('expiresAt')
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
