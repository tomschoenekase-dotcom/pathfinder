import { beforeEach, describe, expect, it, vi } from 'vitest'

const loggerInfo = vi.hoisted(() => vi.fn())

vi.mock('@pathfinder/config/logger', () => ({ logger: { info: loggerInfo } }))

import {
  AppendOnlyModelError,
  PLATFORM_TABLES_LIST,
  SHARED_SCOPE_TABLES_LIST,
  TENANTED_TABLES_LIST,
  TenantIsolationError,
  tenantIsolationInternals,
  tenantIsolationMiddleware,
  withTenantIsolationBypass,
} from './tenant-isolation'

function createParams(
  overrides: Partial<Parameters<typeof tenantIsolationMiddleware>[0]> = {},
): Parameters<typeof tenantIsolationMiddleware>[0] {
  return {
    action: 'findMany',
    args: {},
    model: 'TenantMembership',
    ...overrides,
  }
}

function createMockDb() {
  const next = vi.fn(async (params) => params)

  const run = (params: Parameters<typeof tenantIsolationMiddleware>[0]) =>
    tenantIsolationMiddleware(params, next)

  return {
    next,
    venue: {
      findMany: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'findMany', args, model: 'Venue' })),
      create: (args: Record<string, unknown>) =>
        run(createParams({ action: 'create', args, model: 'Venue' })),
    },
    place: {
      findMany: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'findMany', args, model: 'Place' })),
    },
    tenantMembership: {
      aggregate: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'aggregate', args, model: 'TenantMembership' })),
      count: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'count', args, model: 'TenantMembership' })),
      create: (args: Record<string, unknown>) =>
        run(createParams({ action: 'create', args, model: 'TenantMembership' })),
      deleteMany: (args: Record<string, unknown>) =>
        run(createParams({ action: 'deleteMany', args, model: 'TenantMembership' })),
      findMany: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'findMany', args, model: 'TenantMembership' })),
      groupBy: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'groupBy', args, model: 'TenantMembership' })),
      updateMany: (args: Record<string, unknown>) =>
        run(createParams({ action: 'updateMany', args, model: 'TenantMembership' })),
      upsert: (args: Record<string, unknown>) =>
        run(createParams({ action: 'upsert', args, model: 'TenantMembership' })),
    },
    tenantFeatureFlag: {
      createMany: (args: Record<string, unknown>) =>
        run(createParams({ action: 'createMany', args, model: 'TenantFeatureFlag' })),
    },
    user: {
      findMany: (args: Record<string, unknown> = {}) =>
        run(createParams({ action: 'findMany', args, model: 'User' })),
    },
  }
}

describe('tenantIsolationMiddleware', () => {
  beforeEach(() => {
    loggerInfo.mockReset()
  })

  it('exports the expected table lists', () => {
    expect(TENANTED_TABLES_LIST).toEqual([
      'TenantMembership',
      'CustomerAccessRequest',
      'TenantFeatureFlag',
      'ProductEntitlementOverride',
      'BillingAccount',
      'CommercialAgreement',
      'CommercialAgreementVenue',
      'BillingCheckoutAttempt',
      'BillingInvoiceProjection',
      'BillingEventApplication',
      'BillingReconciliationRun',
      'BillingAccessOverride',
      'BillingCustomerRequest',
      'BillingAgentCommand',
      'Venue',
      'VenueBotConfiguration',
      'PersonalityProfile',
      'CustomCharacter',
      'ClientAssistantPreference',
      'ClientAssistantThread',
      'ClientAssistantTurn',
      'ClientAssistantSupportHandoff',
      'Place',
      'VenueKnowledgeEntry',
      'ContentVersion',
      'EvalCase',
      'EvalRun',
      'EvalRunCostReservation',
      'EvalResult',
      'EvalReview',
      'OnboardingMilestoneEvent',
      'VenueContentImportReceipt',
      'VenuePackage',
      'VenuePackageManifestArtifact',
      'NativeVenueDeploymentArtifact',
      'NativeVenueDeploymentRelease',
      'NativeVenueDeploymentEffect',
      'NativeVenueDeploymentHead',
      'NativeVenueDeploymentCommand',
      'NativeVenueDeploymentPublicationLineage',
      'NativeVenueDeploymentEvaluationEvidence',
      'VenuePackageDuplicateAnalysis',
      'VisitorSession',
      'VoiceSession',
      'VoiceTranscriptSegment',
      'GuestChatTurn',
      'GuestChatProviderOperation',
      'AiUsageEvent',
      'ConversationInsight',
      'OperationalEvent',
      'OperationalEventDelivery',
      'OperationalEventDeliveryAttempt',
      'KnowledgeChangeProposal',
      'VenueFloor',
      'VenueLocation',
      'VenueLocationConnection',
      'AiUsageDailyRollup',
      'AiCostBudget',
      'AiCostReservation',
      'Message',
      'MessageFeedback',
      'OperationalUpdate',
      'AnalyticsEvent',
      'DailyRollup',
      'WeeklyDigest',
      'QuestionCluster',
      'EngagementQuestion',
      'EngagementQuestionResponse',
      'AdminChatlogNote',
      'WeeklyReport',
      'VenueReportConfiguration',
      'AnswerAnalysisSnapshot',
      'GenerationRequestDispatch',
      'VenueWeeklyTheme',
      'MediaIngestionProject',
      'MediaIngestionAsset',
      'EmbeddingWorkClaim',
      'EmbeddingDispatch',
      'AgentIdentity',
      'AgentBridgeSession',
      'AgentWorker',
      'AgentRun',
      'AgentAction',
      'AgentTimelineEvent',
      'AgentMessage',
      'AgentOutcomeObservation',
      'AgentImprovementProposal',
      'AgentImprovementProposalEvidence',
      'ApprovalGrantEvidence',
      'AgentImprovementValidationEvidence',
      'AgentQuestion',
      'OnboardingQuestionLink',
      'ApprovalRequest',
      'ApprovalDecision',
      'ApprovalGrant',
      'ApprovalGrantConsumption',
      'SupportRequest',
      'SupportRequestParticipant',
      'SupportMessage',
      'SupportMessageAttachment',
      'SupportRequestAuditEvent',
      'SupportPackageHandoff',
      'SupportPackageHandoffSupersession',
      'SupportPreviewFeedback',
      'SupportAgentRunLineage',
      'ExternalAccessCredential',
      'ExternalCredentialOperationReceipt',
      'ExternalCredentialRotation',
      'ExternalCredentialRevocation',
      'ExternalCredentialActivation',
      'OffboardingPlan',
      'OffboardingVenueTarget',
      'OffboardingRevocationEvidence',
      'OffboardingExportArtifact',
      'OffboardingExportOperation',
      'ContentModuleIdentity',
      'ContentModuleRevision',
      'ItemContent',
      'ServiceContent',
      'PolicyContent',
      'EventContent',
      'OperationalFactContent',
      'RelationshipContent',
      'ContentModuleEvidence',
      'ContentModulePublication',
      'IntakeRun',
      'IntakeEvidenceRecord',
      'IntakeRunEvent',
      'IntakePackageHandoff',
      'IntakeUpload',
      'IntakeUploadVerificationReceipt',
      'AiScopedWorkloadConfigurationOverride',
      'AiScopedWorkloadConfigurationHistory',
      'ProspectConversion',
      'ProspectCustomerRelationship',
      'ProspectLocationConversion',
    ])
    expect(PLATFORM_TABLES_LIST).toEqual([
      'User',
      'Tenant',
      'PlatformConfig',
      'ClerkWebhookReceipt',
      'AiWorkloadConfigurationOverride',
      'AiWorkloadConfigurationHistory',
      'ClientCreateIntent',
      'ClientCreateIntentEvent',
      'ProductPlanCapability',
      'PlatformWorkerPolicyCredential',
      'StripeWebhookReceipt',
      'ProspectTerritory',
      'ProspectTag',
      'ProspectOrganizationTag',
      'CorrespondenceProviderAccount',
      'GoogleCalendarSyncState',
      'CompanyMeetingTranscriptArtifact',
      'ProspectDeliveryControl',
      'ProspectOrganization',
      'ProspectResearchJob',
      'ProspectResearchAttempt',
      'ProspectVenue',
      'ProspectContact',
      'ProspectContactSuppressionEvent',
      'ProspectOpportunity',
      'ProspectStageHistory',
      'ProspectActivity',
      'ProspectSourceEvidence',
      'ProspectDuplicateCandidate',
      'ProspectImport',
      'ProspectImportSheet',
      'ProspectImportRow',
      'ProspectImportReportEntry',
      'ProspectImportSourceRecord',
      'ProspectSavedView',
      'ProspectOutreachCampaign',
      'ProspectCampaignMember',
      'ProspectOutreachDraft',
      'ProspectSendBatch',
      'ProspectSendItem',
      'ProspectSendOutbox',
      'ProspectEmailThread',
      'ProspectEmailThreadProvider',
      'ProspectEmailMessage',
      'ProspectEmailAttachmentRetentionRequest',
      'ProspectEmailEvent',
      'ProspectFollowup',
      'ProspectEmailWebhookReceipt',
      'PlatformOperationalEvent',
      'FounderControlRoomReview',
      'EncryptedIntegrationCredential',
      'GmailOAuthAttempt',
      'ProspectInboundQuarantine',
    ])
    expect(SHARED_SCOPE_TABLES_LIST).toEqual([
      'AuditLog',
      'JobRecord',
      'OperatingCostEvidence',
      'CompanyKnowledgeItem',
      'CompanyKnowledgeRevision',
      'CompanyKnowledgeSource',
      'CompanyKnowledgeEntityLink',
      'CompanyKnowledgeRelation',
      'CompanyDecision',
      'CompanyPriority',
      'AccountRelationshipNote',
      'AccountMilestone',
      'AccountOpenLoop',
      'AccountCommitment',
      'AccountSummary',
      'CompanyMeeting',
      'CompanyMeetingParticipant',
      'CompanyMeetingExtraction',
    ])
  })

  it('findMany on a tenanted table with tenantId passes', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.findMany({ where: { tenantId: 'org_1' } }),
    ).resolves.toMatchObject({
      args: { where: { tenantId: 'org_1' } },
      model: 'TenantMembership',
    })
  })

  it.each(
    [
      'AiUsageEvent',
      'EvalCase',
      'EvalResult',
      'EvalReview',
      'OnboardingMilestoneEvent',
      'AgentAction',
      'AgentTimelineEvent',
      'ApprovalRequest',
      'ApprovalDecision',
      'SupportMessage',
      'SupportMessageAttachment',
      'SupportRequestAuditEvent',
      'SupportPackageHandoff',
      'SupportPackageHandoffSupersession',
      'SupportPreviewFeedback',
      'SupportAgentRunLineage',
      'ClientAssistantSupportHandoff',
      'BillingEventApplication',
      'BillingAccessOverride',
      'ExternalCredentialRotation',
      'ExternalCredentialRevocation',
      'ExternalCredentialActivation',
      'OffboardingVenueTarget',
      'OffboardingRevocationEvidence',
      'OffboardingExportArtifact',
      'ContentModuleIdentity',
      'ContentModuleRevision',
      'ItemContent',
      'ServiceContent',
      'PolicyContent',
      'EventContent',
      'OperationalFactContent',
      'RelationshipContent',
      'ContentModuleEvidence',
      'ContentModulePublication',
      'IntakeRun',
      'IntakeEvidenceRecord',
      'IntakeUploadVerificationReceipt',
      'IntakeRunEvent',
      'IntakePackageHandoff',
      'AiScopedWorkloadConfigurationHistory',
      'AiWorkloadConfigurationHistory',
      'ClientCreateIntentEvent',
      'ProspectStageHistory',
      'ProspectActivity',
      'ProspectSourceEvidence',
      'ProspectContactSuppressionEvent',
      'ProspectEmailEvent',
      'ProspectImportReportEntry',
    ].flatMap((model) =>
      ['update', 'updateMany', 'upsert', 'delete', 'deleteMany'].map((action) => [model, action]),
    ),
  )('rejects %s %s on append-only models even with tenant scope', async (model, action) => {
    const next = vi.fn(async (params) => params)

    await expect(
      tenantIsolationMiddleware(
        createParams({
          action,
          model,
          args: {
            where: { tenantId: 'org_1' },
            create: { tenantId: 'org_1' },
            data: { tenantId: 'org_1' },
          },
        }),
        next,
      ),
    ).rejects.toEqual(new AppendOnlyModelError(model, action))
    expect(next).not.toHaveBeenCalled()
  })

  it.each(
    [
      'AgentRun',
      'EvalRun',
      'SupportRequest',
      'SupportRequestParticipant',
      'OffboardingPlan',
      'OffboardingExportOperation',
      'IntakeUpload',
      'VenueBotConfiguration',
      'PersonalityProfile',
      'CustomCharacter',
      'ClientAssistantPreference',
      'ClientAssistantThread',
      'ClientAssistantTurn',
    ].flatMap((model) => ['delete', 'deleteMany'].map((action) => [model, action])),
  )('rejects %s %s while preserving lifecycle updates', async (model, action) => {
    const next = vi.fn(async (params) => params)

    await expect(
      tenantIsolationMiddleware(
        createParams({ action, model, args: { where: { tenantId: 'org_1' } } }),
        next,
      ),
    ).rejects.toEqual(new AppendOnlyModelError(model, action))
    expect(next).not.toHaveBeenCalled()
  })

  it('allows tenant-scoped AgentRun lifecycle updates', async () => {
    const next = vi.fn(async (params) => params)
    await expect(
      tenantIsolationMiddleware(
        createParams({
          action: 'update',
          model: 'AgentRun',
          args: { where: { tenantId: 'org_1' }, data: { status: 'RUNNING' } },
        }),
        next,
      ),
    ).resolves.toMatchObject({ action: 'update', model: 'AgentRun' })
  })

  it('allows tenant-scoped EvalRun lifecycle updates', async () => {
    const next = vi.fn(async (params) => params)
    await expect(
      tenantIsolationMiddleware(
        createParams({
          action: 'updateMany',
          model: 'EvalRun',
          args: { where: { tenantId: 'org_1' }, data: { status: 'RUNNING' } },
        }),
        next,
      ),
    ).resolves.toMatchObject({ model: 'EvalRun' })
  })

  it('allows tenant-scoped SupportRequest version updates', async () => {
    const next = vi.fn(async (params) => params)
    await expect(
      tenantIsolationMiddleware(
        createParams({
          action: 'updateMany',
          model: 'SupportRequest',
          args: { where: { tenantId: 'org_1' }, data: { version: 2 } },
        }),
        next,
      ),
    ).resolves.toMatchObject({ action: 'updateMany', model: 'SupportRequest' })
  })

  it('findMany on a tenanted table without tenantId throws', async () => {
    const db = createMockDb()

    await expect(db.tenantMembership.findMany({})).rejects.toEqual(
      new TenantIsolationError('TenantMembership', 'findMany'),
    )
  })

  it('create on a tenanted table with tenantId in data passes', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.create({
        data: { tenantId: 'org_1', role: 'OWNER' },
      }),
    ).resolves.toMatchObject({
      args: { data: { tenantId: 'org_1', role: 'OWNER' } },
      action: 'create',
    })
  })

  it('create on a tenanted table without tenantId throws', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.create({
        data: { role: 'OWNER' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'create'))
  })

  it('findMany on a platform table without tenantId passes', async () => {
    const db = createMockDb()

    await expect(db.user.findMany({})).resolves.toMatchObject({
      model: 'User',
      action: 'findMany',
    })
  })

  it('admin bypass allows tenanted queries without tenantId', async () => {
    const db = createMockDb()

    await expect(
      withTenantIsolationBypass(() => db.tenantMembership.findMany({})),
    ).resolves.toMatchObject({
      model: 'TenantMembership',
      action: 'findMany',
    })
    expect(loggerInfo).toHaveBeenCalledWith({
      action: 'tenant_isolation.bypass',
      caller: expect.stringMatching(/tenant-isolation\.test\.ts:\d+:\d+$/),
    })
  })

  it('retains bypass context while assimilating a lazy Prisma-style thenable', async () => {
    const next = vi.fn(async (params) => params)
    const lazyQuery = {
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return tenantIsolationMiddleware(
          createParams({ action: 'findMany', args: { where: {} }, model: 'Venue' }),
          next,
        ).then(onfulfilled, onrejected)
      },
    } as PromiseLike<unknown> as Promise<unknown>

    await expect(withTenantIsolationBypass(() => lazyQuery)).resolves.toMatchObject({
      model: 'Venue',
      action: 'findMany',
    })
    expect(next).toHaveBeenCalledOnce()
  })

  it('shares the request-scoped bypass across duplicate server module evaluation', async () => {
    const next = vi.fn(async (params) => params)

    await withTenantIsolationBypass(async () => {
      vi.resetModules()
      const duplicateModule = await import('./tenant-isolation')
      await expect(
        duplicateModule.tenantIsolationMiddleware(
          createParams({ action: 'count', args: { where: { isActive: true } }, model: 'Venue' }),
          next,
        ),
      ).resolves.toMatchObject({ action: 'count', model: 'Venue' })
    })
  })

  it('normalizes production and bundled bypass caller identities', () => {
    expect(
      tenantIsolationInternals.resolveBypassCaller(
        'Error\n    at resolveBypassCaller (C:\\repo\\packages\\db\\src\\middleware\\tenant-isolation.ts:1:1)\n    at withTenantIsolationBypass (C:\\repo\\packages\\db\\src\\middleware\\tenant-isolation.ts:2:2)\n    at runReport (C:\\repo\\apps\\workers\\dist\\index.js:123:45)',
      ),
    ).toBe('apps/workers/dist/index.js:123:45')
    expect(
      tenantIsolationInternals.resolveBypassCaller(
        'Error\n    at e (C:\\deploy\\.next\\server\\chunks\\bundle.js:1:1)\n    at t (C:\\deploy\\.next\\server\\chunks\\bundle.js:2:2)\n    at C:\\Users\\alice\\deploy\\.next\\server\\chunks\\abc123.js:10:2',
      ),
    ).toBe('.next/server/chunks/[chunk].js:10:2')
    expect(
      tenantIsolationInternals.resolveBypassCaller(
        'Error\n    at e (C:\\deploy\\dist\\index.js:1:1)\n    at t (C:\\deploy\\dist\\index.js:2:2)\n    at C:\\private\\service\\handler.js:10:2',
      ),
    ).toBe('unknown')
    expect(tenantIsolationInternals.resolveBypassCaller('Error')).toBe('unknown')
  })

  it('updateMany requires where.tenantId', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.updateMany({
        where: { status: 'ACTIVE' },
        data: { status: 'REMOVED' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'updateMany'))

    await expect(
      db.tenantMembership.updateMany({
        where: { tenantId: 'org_1', status: 'ACTIVE' },
        data: { status: 'REMOVED' },
      }),
    ).resolves.toMatchObject({
      action: 'updateMany',
    })
  })

  it('deleteMany requires where.tenantId', async () => {
    const db = createMockDb()

    await expect(
      db.tenantMembership.deleteMany({
        where: { status: 'REMOVED' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'deleteMany'))

    await expect(
      db.tenantMembership.deleteMany({
        where: { tenantId: 'org_1' },
      }),
    ).resolves.toMatchObject({
      action: 'deleteMany',
    })
  })

  it.each(['count', 'aggregate', 'groupBy'] as const)(
    '%s requires where.tenantId',
    async (operation) => {
      const db = createMockDb()

      await expect(db.tenantMembership[operation]({})).rejects.toEqual(
        new TenantIsolationError('TenantMembership', operation),
      )
      await expect(
        db.tenantMembership[operation]({ where: { tenantId: 'org_1' } }),
      ).resolves.toMatchObject({ action: operation })
    },
  )

  it('upsert requires tenantId in both create and where', async () => {
    const db = createMockDb()

    // Missing tenantId in create — must throw regardless of where
    await expect(
      db.tenantMembership.upsert({
        where: { id: 'membership_1' },
        update: { role: 'MANAGER' },
        create: { userId: 'user_1', role: 'OWNER' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'upsert'))

    // create has tenantId but where does not — reject cross-tenant updates
    await expect(
      db.tenantMembership.upsert({
        where: { id: 'membership_1' },
        update: { role: 'MANAGER' },
        create: { tenantId: 'org_1', userId: 'user_1', role: 'OWNER' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'upsert'))

    // both have tenantId — also allowed
    await expect(
      db.tenantMembership.upsert({
        where: { tenantId: 'org_1' },
        update: { role: 'MANAGER' },
        create: { tenantId: 'org_1', userId: 'user_1', role: 'OWNER' },
      }),
    ).resolves.toMatchObject({ action: 'upsert' })

    await expect(
      db.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: 'org_2', userId: 'user_1' } },
        update: { role: 'MANAGER' },
        create: { tenantId: 'org_1', userId: 'user_1', role: 'OWNER' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'upsert'))

    // A nested compound key alone is not sufficient; the root query must be scoped.
    await expect(
      db.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: 'org_1', userId: 'user_1' } },
        update: { role: 'MANAGER' },
        create: { tenantId: 'org_1', userId: 'user_1', role: 'OWNER' },
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantMembership', 'upsert'))

    await expect(
      db.tenantMembership.upsert({
        where: {
          tenantId: 'org_1',
          tenantId_userId: { tenantId: 'org_1', userId: 'user_1' },
        },
        update: { role: 'MANAGER' },
        create: { tenantId: 'org_1', userId: 'user_1', role: 'OWNER' },
      }),
    ).resolves.toMatchObject({ action: 'upsert' })
  })

  it('createMany checks every payload item and ignores nested writes beyond the top-level model', async () => {
    const db = createMockDb()

    await expect(
      db.tenantFeatureFlag.createMany({
        data: [
          { tenantId: 'org_1', flagKey: 'integrations.square' },
          { flagKey: 'analytics.advanced' },
        ],
      }),
    ).rejects.toEqual(new TenantIsolationError('TenantFeatureFlag', 'createMany'))

    await expect(
      db.tenantFeatureFlag.createMany({
        data: [{ tenantId: 'org_1', flagKey: 'integrations.square', memberships: { create: {} } }],
      }),
    ).resolves.toMatchObject({
      action: 'createMany',
    })
  })

  it('findMany on Venue without tenantId throws TenantIsolationError', async () => {
    const db = createMockDb()

    await expect(db.venue.findMany({})).rejects.toEqual(
      new TenantIsolationError('Venue', 'findMany'),
    )
  })

  it('findMany on Venue with tenantId passes', async () => {
    const db = createMockDb()

    await expect(db.venue.findMany({ where: { tenantId: 'org_1' } })).resolves.toMatchObject({
      model: 'Venue',
      action: 'findMany',
    })
  })

  it('create on Venue without tenantId throws TenantIsolationError', async () => {
    const db = createMockDb()

    await expect(db.venue.create({ data: { name: 'City Zoo', slug: 'city-zoo' } })).rejects.toEqual(
      new TenantIsolationError('Venue', 'create'),
    )
  })

  it('findMany on Place without tenantId throws TenantIsolationError', async () => {
    const db = createMockDb()

    await expect(db.place.findMany({})).rejects.toEqual(
      new TenantIsolationError('Place', 'findMany'),
    )
  })

  it('findMany on Place with tenantId passes', async () => {
    const db = createMockDb()

    await expect(db.place.findMany({ where: { tenantId: 'org_1' } })).resolves.toMatchObject({
      model: 'Place',
      action: 'findMany',
    })
  })

  it('helper branches handle unknown actions and raw tenant key checks', async () => {
    const next = vi.fn(async (params) => params)

    expect(tenantIsolationInternals.hasOwnTenantKey(null)).toBe(false)
    expect(tenantIsolationInternals.hasOwnTenantKey([])).toBe(false)
    expect(tenantIsolationInternals.hasOwnTenantKey({ tenantId: undefined })).toBe(true)
    expect(tenantIsolationInternals.hasOwnTenantKey({})).toBe(false)
    expect(tenantIsolationInternals.hasTenantIdValue({ tenantId: null })).toBe(false)
    expect(tenantIsolationInternals.hasTenantIdValue({ tenant_id: 'org_1' })).toBe(true)
    expect(
      tenantIsolationInternals.hasTenantIdValue({
        OR: [{ tenantId: 'org_1' }, { id: 'foreign' }],
      }),
    ).toBe(false)
    expect(tenantIsolationInternals.hasTenantIdValue({ venue: { tenantId: 'org_1' } })).toBe(false)
    expect(tenantIsolationInternals.hasTenantIdInCreateData([{ tenantId: 'org_1' }])).toBe(true)
    expect(tenantIsolationInternals.requiresWhereTenantId('findUnique')).toBe(true)
    expect(tenantIsolationInternals.requiresWhereTenantId('aggregate')).toBe(true)
    expect(tenantIsolationInternals.isBypassEnabled()).toBe(false)

    await expect(
      tenantIsolationMiddleware(
        createParams({
          action: 'unknownOperation',
          model: 'TenantMembership',
          args: {},
        }),
        next,
      ),
    ).resolves.toMatchObject({
      action: 'unknownOperation',
    })
  })
})
