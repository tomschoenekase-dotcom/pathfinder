import { describe, expect, it, vi } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './registry'
import {
  createPathfinderMcpReadActions,
  decodeMcpReadCursor,
  encodeMcpReadCursor,
  McpReadBindingError,
  readMcpResource,
} from './read-actions'

const credential: VerifiedMcpCredentialScope = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: [
    'resources:read',
    'clients:read',
    'billing:read',
    'venues:read',
    'configuration:read',
    'content:read',
    'history:read',
    'packages:read',
    'support:read',
    'updates:read',
    'ai-usage:read',
    'jobs:read',
    'evaluations:read',
    'reports:read',
    'conversations:read',
    'integrations:read',
    'agent-runs:read',
    'events:read',
    'deployments:read',
    'feature-flags:read',
    'readiness:read',
    'questions:read',
    'outcomes:read',
    'agent-improvements:read',
  ],
}

function database() {
  return {
    tenant: { findFirst: vi.fn() },
    billingAccount: { findFirst: vi.fn() },
    venue: { findFirst: vi.fn(), findMany: vi.fn() },
    place: { findMany: vi.fn(), count: vi.fn() },
    venueKnowledgeEntry: { findMany: vi.fn(), count: vi.fn() },
    contentVersion: { findMany: vi.fn() },
    venuePackage: { findMany: vi.fn(), groupBy: vi.fn() },
    offboardingPlan: { findMany: vi.fn() },
    supportRequest: { findMany: vi.fn() },
    operationalUpdate: { findMany: vi.fn() },
    aiUsageDailyRollup: { findMany: vi.fn() },
    aiCostBudget: { findFirst: vi.fn() },
    jobRecord: {
      findMany: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    platformConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    evalRun: { findMany: vi.fn() },
    weeklyReport: { findMany: vi.fn() },
    visitorSession: { findMany: vi.fn() },
    externalAccessCredential: { findMany: vi.fn() },
    agentRun: { findFirst: vi.fn(), findMany: vi.fn() },
    agentAction: { findMany: vi.fn() },
    agentTimelineEvent: { findMany: vi.fn() },
    approvalRequest: { findMany: vi.fn() },
    operationalEvent: { findMany: vi.fn() },
    nativeVenueDeploymentRelease: { findMany: vi.fn() },
    nativeVenueDeploymentHead: { findFirst: vi.fn() },
    nativeVenueDeploymentEvaluationEvidence: { findFirst: vi.fn() },
    tenantFeatureFlag: { findMany: vi.fn() },
    venueReportConfiguration: { findFirst: vi.fn() },
    agentQuestion: { findMany: vi.fn() },
    agentOutcomeObservation: { findMany: vi.fn() },
    agentImprovementProposal: { findMany: vi.fn() },
    onboardingMilestoneEvent: { findMany: vi.fn() },
    guestAnswerAttribution: { findMany: vi.fn() },
  }
}

const unavailableWrites: Omit<PathfinderMcpDomainActions, 'read'> = {
  accountContext: vi.fn(),
  addSupportInternalNote: vi.fn(),
  accountTimeline: vi.fn(),
  accountMeetings: vi.fn(),
  accountMeetingGet: vi.fn(),
  processMeeting: vi.fn(),
  accountCorrespondence: vi.fn(),
  knowledgeSearch: vi.fn(),
  knowledgeGet: vi.fn(),
  listKnowledgeGaps: vi.fn(),
  listGuestAnswerAttributions: vi.fn(),
  proposeKnowledgeCorrection: vi.fn(),
  proposeLocationDraft: vi.fn(),
  proposeSupportTriage: vi.fn(),
  applySupportTriage: vi.fn(),
  proposeSupportInformationRequest: vi.fn(),
  applySupportInformationRequest: vi.fn(),
  proposeSupportCompletion: vi.fn(),
  applySupportCompletion: vi.fn(),
  proposeSupportPackageDraft: vi.fn(),
  applySupportPackageDraft: vi.fn(),
  proposeSupportPackageApproval: vi.fn(),
  applySupportPackageApproval: vi.fn(),
  proposeSupportPackageApplication: vi.fn(),
  applySupportPackageApplication: vi.fn(),
  proposeSupportPackageReversion: vi.fn(),
  applySupportPackageReversion: vi.fn(),
  proposeSupportPackageHandoffSupersession: vi.fn(),
  applySupportPackageHandoffSupersession: vi.fn(),
  proposeAgentImprovement: vi.fn(),
  recordAgentImprovementValidation: vi.fn(),
  prepareCustomerAccessInvitation: vi.fn(),
  integrationHealth: vi.fn(),
  reportLifecycle: vi.fn(),
  verifyApprovalGrant: vi.fn(),
  proposeBillingAction: vi.fn(),
  askOperator: vi.fn(),
  delegateSpecialist: vi.fn(),
  createPackageDraft: vi.fn(),
  createUpdateDraft: vi.fn(),
  createSupportDraft: vi.fn(),
  openSupportRequest: vi.fn(),
  createIntakeNotesProposal: vi.fn(),
  generateWeeklyReportDraft: vi.fn(),
  requestEvaluation: vi.fn(),
}

describe('MCP v0 concrete read bindings', () => {
  it('binds through the registry and reapplies exact tenant/client/venue scope to safe selects', async () => {
    const db = database()
    db.place.findMany.mockResolvedValue([
      {
        id: 'place-1',
        name: 'Gallery',
        type: 'gallery',
        itemType: null,
        shortDescription: 'Open today',
        longDescription: null,
        lat: null,
        lng: null,
        tags: [],
        areaName: null,
        hours: null,
        sourceType: 'HUMAN',
        authorship: 'CLIENT',
        sourceName: null,
        lastReviewedAt: null,
        createdAt: new Date('2026-08-11T12:00:00.000Z'),
        updatedAt: new Date('2026-08-11T12:00:00.000Z'),
      },
    ])
    db.venueKnowledgeEntry.findMany.mockResolvedValue([])
    const registry = createPathfinderMcpRegistry(
      createPathfinderMcpReadActions(db as never, unavailableWrites),
    )

    const response = await registry.callTool(
      'pathfinder.read',
      { resource: 'content', clientId: 'tenant-1', venueId: 'venue-1', limit: 1 },
      { credential },
    )

    expect(response.structuredContent.data).toMatchObject({
      items: [{ id: 'place-1', contentKind: 'place' }],
      nextCursor: null,
    })
    for (const delegate of [db.place, db.venueKnowledgeEntry]) {
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
          take: 2,
        }),
      )
    }
    const serialized = JSON.stringify(response.structuredContent)
    expect(serialized).not.toContain('tenant-2')
    expect(serialized).not.toContain('secret')
  })

  it('denies mismatched verified tenant/client scope even when request and clientId agree', async () => {
    const db = database()
    await expect(
      readMcpResource(
        db as never,
        { resource: 'clients', clientId: 'client-alias', limit: 25 },
        { credential: { ...credential, clientId: 'client-alias' } },
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_INVARIANT' })
    expect(db.tenant.findFirst).not.toHaveBeenCalled()
  })

  it('returns a tenant-scoped billing projection without provider IDs, internal notes, or payment links', async () => {
    const db = database()
    db.tenant.findFirst.mockResolvedValue({
      id: 'tenant-1',
      status: 'ACTIVE',
      billingAccount: { status: 'ACTIVE' },
    })
    db.venue.findMany.mockResolvedValue([
      {
        id: 'venue-1',
        name: 'Harbor Museum',
        isActive: true,
        venueBotConfiguration: { id: 'bot-config-1' },
        _count: { places: 8, knowledgeEntries: 3, venuePackageManifestArtifacts: 1 },
      },
    ])
    db.venuePackage.groupBy.mockResolvedValue([
      { venueId: 'venue-1', status: 'APPLIED', _count: { _all: 2 } },
    ])
    db.offboardingPlan.findMany.mockResolvedValue([])
    db.billingAccount.findFirst.mockResolvedValue({
      billingMode: 'STRIPE_SUBSCRIPTION',
      currency: 'usd',
      status: 'ACTIVE',
      paidThroughAt: new Date('2026-09-20T00:00:00.000Z'),
      gracePeriodEndsAt: null,
      reconciliationHealth: 'CURRENT',
      lastReconciledAt: new Date('2026-08-20T12:00:00.000Z'),
      tenant: {
        prospectCustomerRelationships: [
          {
            startedAt: new Date('2026-01-01T00:00:00.000Z'),
            organization: {
              id: 'organization-1',
              canonicalName: 'Harbor Museum Foundation',
              relationshipTier: 'HIGH_TOUCH',
            },
          },
        ],
      },
      commercialAgreements: [
        {
          id: 'agreement-1',
          isBase: true,
          internalPlanKey: 'negotiated',
          status: 'ACTIVE',
          billingMode: 'STRIPE_SUBSCRIPTION',
          billingInterval: 'MONTH',
          billingIntervalCount: 1,
          agreedAmountMinor: 8500n,
          currency: 'usd',
          coveredVenueCount: 1,
          currentPeriodEndsAt: new Date('2026-09-20T00:00:00.000Z'),
          cancelAtPeriodEnd: false,
          cancellationEffectiveAt: null,
          accessEndsAt: null,
        },
      ],
      invoiceProjections: [
        {
          id: 'invoice-1',
          invoiceNumber: 'T-0001',
          status: 'PAID',
          amountDueMinor: 8500n,
          amountPaidMinor: 8500n,
          amountRemainingMinor: 0n,
          currency: 'usd',
          dueAt: null,
          paidAt: new Date('2026-08-20T12:00:00.000Z'),
          failedAt: null,
          nextRetryAt: null,
          failureSummary: null,
        },
      ],
      stripeCustomerId: 'cus_secret',
      internalNotes: 'never expose',
      hostedInvoiceUrl: 'https://secret',
    })
    const response = await readMcpResource(
      db as never,
      { resource: 'billing', clientId: 'tenant-1', limit: 25 },
      { credential },
    )
    expect(db.billingAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1' } }),
    )
    expect(
      db.billingAccount.findFirst.mock.calls[0]![0].select.invoiceProjections,
    ).not.toHaveProperty('take')
    expect(response.data).toMatchObject({
      status: 'ACTIVE',
      paidThroughAt: '2026-09-20T00:00:00.000Z',
      paymentRecovery: {
        schemaVersion: 'torchiko-payment-recovery-context-v1',
        state: 'NOT_REQUIRED',
        reviewRequired: false,
        policy: {
          automaticRestrictionAuthorized: false,
          automaticCustomerContactAuthorized: false,
          graceAndCutoffPolicy: 'UNRESOLVED',
        },
        relationship: {
          organizationId: 'organization-1',
          relationshipTier: 'HIGH_TOUCH',
        },
      },
      customerStatePreservation: {
        schemaVersion: 'torchiko-customer-state-preservation-v1',
        policy: {
          automaticReactivationAuthorized: false,
          automaticCustomerContactAuthorized: false,
          retentionPolicy: 'UNRESOLVED',
          pauseFeePolicy: 'UNRESOLVED',
          reactivationFeePolicy: 'UNRESOLVED',
        },
        venues: [
          {
            venueId: 'venue-1',
            reviewState: 'ACTIVE_SERVICE',
            material: { packageRecordCount: 2, botConfigurationRecordPreserved: true },
          },
        ],
      },
    })
    expect(db.venue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', id: { in: ['venue-1'] } },
      }),
    )
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain('cus_secret')
    expect(serialized).not.toContain('never expose')
    expect(serialized).not.toContain('https://secret')
  })

  it('denies cross-venue access before any database delegate is called', async () => {
    const db = database()
    await expect(
      readMcpResource(
        db as never,
        { resource: 'support', clientId: 'tenant-1', venueId: 'venue-2', limit: 25 },
        { credential },
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_INVARIANT' })
    expect(db.supportRequest.findMany).not.toHaveBeenCalled()
  })

  it('uses deterministic resource-bound cursors and rejects substitution or malformed tokens', () => {
    const cursor = encodeMcpReadCursor({
      resource: 'content',
      sortAt: '2026-08-11T12:00:00.000Z',
      id: 'place-1',
    })
    expect(cursor).toBe(
      encodeMcpReadCursor({
        resource: 'content',
        sortAt: '2026-08-11T12:00:00.000Z',
        id: 'place-1',
      }),
    )
    expect(decodeMcpReadCursor(cursor, 'content')).toMatchObject({
      resource: 'content',
      id: 'place-1',
    })
    expect(() => decodeMcpReadCursor(cursor, 'support')).toThrow(McpReadBindingError)
    expect(() => decodeMcpReadCursor('not-json', 'content')).toThrow(McpReadBindingError)
  })

  it('never selects raw content snapshots, package payloads, support artifacts, or internal messages', async () => {
    const db = database()
    db.contentVersion.findMany.mockResolvedValue([])
    db.venuePackage.findMany.mockResolvedValue([])
    db.supportRequest.findMany.mockResolvedValue([])

    for (const resource of ['history', 'packages', 'support'] as const) {
      await readMcpResource(
        db as never,
        { resource, clientId: 'tenant-1', venueId: 'venue-1', limit: 100 },
        { credential },
      )
    }

    const historySelect = db.contentVersion.findMany.mock.calls[0]![0].select
    expect(historySelect).not.toHaveProperty('beforeState')
    expect(historySelect).not.toHaveProperty('afterState')
    expect(historySelect).not.toHaveProperty('sourceProvenance')
    const packageSelect = db.venuePackage.findMany.mock.calls[0]![0].select
    expect(packageSelect).not.toHaveProperty('payload')
    expect(packageSelect).not.toHaveProperty('validationReport')
    expect(packageSelect).not.toHaveProperty('previewPlan')
    const supportSelect = db.supportRequest.findMany.mock.calls[0]![0].select
    expect(supportSelect).not.toHaveProperty('artifacts')
    expect(supportSelect).not.toHaveProperty('messages')
    expect(supportSelect).not.toHaveProperty('auditEvents')
    expect(db.contentVersion.findMany.mock.calls[0]![0].take).toBe(101)
  })

  it('never selects or returns credential-bearing content or configuration URLs', async () => {
    const db = database()
    db.place.findMany.mockResolvedValue([
      {
        id: 'place-url-test',
        name: 'Safe name',
        createdAt: new Date('2026-08-11T12:00:00.000Z'),
        updatedAt: new Date('2026-08-11T12:00:00.000Z'),
        sourceUrl: 'https://source.invalid/file?token=source-secret',
        photoUrl: 'https://media.invalid/file?X-Amz-Credential=media-secret',
      },
    ])
    db.venueKnowledgeEntry.findMany.mockResolvedValue([
      {
        id: 'knowledge-url-test',
        title: 'Safe title',
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
        updatedAt: new Date('2026-08-10T12:00:00.000Z'),
        sourceUrl: 'https://source.invalid/file?token=knowledge-secret',
      },
    ])
    db.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      aiTone: 'FRIENDLY',
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      aiGuideName: 'Guide',
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      guideMode: 'location_aware',
      defaultCenterLat: null,
      defaultCenterLng: null,
      isActive: true,
      updatedAt: new Date('2026-08-11T12:00:00.000Z'),
      chatLogoUrl: 'https://media.invalid/logo?token=logo-secret',
      chatBannerUrl: 'https://media.invalid/banner?X-Amz-Credential=banner-secret',
    })

    const content = await readMcpResource(
      db as never,
      { resource: 'content', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    const configuration = await readMcpResource(
      db as never,
      { resource: 'configuration', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )

    for (const select of [
      db.place.findMany.mock.calls[0]![0].select,
      db.venueKnowledgeEntry.findMany.mock.calls[0]![0].select,
    ]) {
      expect(select).not.toHaveProperty('sourceUrl')
      expect(select).not.toHaveProperty('photoUrl')
    }
    const configurationSelect = db.venue.findFirst.mock.calls[0]![0].select
    expect(configurationSelect).not.toHaveProperty('chatLogoUrl')
    expect(configurationSelect).not.toHaveProperty('chatBannerUrl')
    const serialized = JSON.stringify({ content, configuration })
    expect(serialized).not.toContain('X-Amz-Credential')
    expect(serialized).not.toContain('token=')
    expect(serialized).not.toContain('source-secret')
    expect(serialized).not.toContain('media-secret')
    expect(serialized).not.toContain('logo-secret')
    expect(serialized).not.toContain('banner-secret')
  })

  it('does not select evaluation error detail', async () => {
    const db = database()
    db.evalRun.findMany.mockResolvedValue([])
    await readMcpResource(
      db as never,
      { resource: 'evaluations', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    expect(db.evalRun.findMany.mock.calls[0]![0].select).not.toHaveProperty('lastErrorCode')
  })

  it('uses an exact venue predicate for jobs without selecting payload or error fields', async () => {
    const db = database()
    db.jobRecord.findMany.mockResolvedValue([])
    await readMcpResource(
      db as never,
      { resource: 'jobs', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    const query = db.jobRecord.findMany.mock.calls[0]![0]
    expect(query.where).toMatchObject({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(query.select).not.toHaveProperty('payload')
    expect(query.select).not.toHaveProperty('error')
    expect(db.jobRecord.groupBy).toHaveBeenCalledTimes(2)
    expect(db.jobRecord.groupBy.mock.calls[0]![0].where).toEqual({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(db.jobRecord.count.mock.calls[0]![0].where).toMatchObject({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      status: 'RUNNING',
    })
  })

  it('separates persisted venue job pressure from live queue and execution claims', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'))
    try {
      const db = database()
      db.jobRecord.findMany.mockResolvedValue([
        {
          id: 'job-1',
          queue: 'weekly-report',
          jobName: 'weekly-report-process',
          status: 'FAILED',
          attemptNumber: 3,
          maxAttempts: 3,
          failureDisposition: 'ATTEMPTS_EXHAUSTED',
          terminalAt: new Date('2026-08-23T11:50:00.000Z'),
          startedAt: new Date('2026-08-23T11:45:00.000Z'),
          completedAt: new Date('2026-08-23T11:50:00.000Z'),
          createdAt: new Date('2026-08-23T11:44:00.000Z'),
        },
      ])
      db.jobRecord.groupBy
        .mockResolvedValueOnce([
          {
            status: 'FAILED',
            _count: { _all: 2 },
            _min: { startedAt: new Date('2026-08-23T11:00:00.000Z') },
            _max: { completedAt: new Date('2026-08-23T11:50:00.000Z') },
          },
        ])
        .mockResolvedValueOnce([{ failureDisposition: 'ATTEMPTS_EXHAUSTED', _count: { _all: 2 } }])
      db.jobRecord.count.mockResolvedValue(1)
      db.platformConfig.findUnique.mockResolvedValue({
        value: {
          schemaVersion: 1,
          observedAt: '2026-08-23T11:59:30.000Z',
          mode: 'provider-disabled',
          revision: 'revision-1',
          schedulersEnabled: false,
        },
        updatedAt: new Date('2026-08-23T11:59:31.000Z'),
      })

      const response = await readMcpResource(
        db as never,
        { resource: 'jobs', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
        { credential },
      )
      const payload = response.data
      expect(payload).toMatchObject({
        schemaVersion: 'pathfinder.jobs.v2',
        scope: { clientId: 'tenant-1', venueId: 'venue-1' },
        persisted: {
          byStatus: [{ status: 'FAILED', count: 2 }],
          failedByDisposition: [{ disposition: 'ATTEMPTS_EXHAUSTED', count: 2 }],
          longRunning: { count: 1, observedAfterMs: 900000, classification: 'DIAGNOSTIC_ONLY' },
        },
        workerRuntime: {
          state: 'FRESH',
          fresh: true,
          mode: 'provider-disabled',
          revision: 'revision-1',
          schedulersEnabled: false,
        },
        boundaries: {
          persistedRecordsAreLiveQueue: false,
          liveRedisQueueInspected: false,
          liveQueueDepthKnown: false,
          absenceOfRecordsMeansHealthy: false,
          automaticRetryAuthorized: false,
          providerExecutionProven: false,
          serviceLevelObjectivePolicy: 'UNRESOLVED',
        },
      })
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain('private job error')
      expect(serialized).not.toContain('redis://')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns exact configured cost protection with usage while excluding policy and operator material', async () => {
    const db = database()
    db.aiUsageDailyRollup.findMany.mockResolvedValue([
      {
        id: 'rollup-1',
        date: new Date('2026-08-23T00:00:00.000Z'),
        feature: 'guest-chat',
        requestCount: 4,
        successfulRequestCount: 3,
        failedRequestCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        cachedAudioInputTokens: 0,
        totalTokens: 150,
        estimatedCostUsd: '0.12500000',
      },
    ])
    db.aiCostBudget.findFirst.mockResolvedValue({
      coverageVersion: 'gateway-v1',
      enabled: true,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2030-01-01T00:00:00.000Z'),
      limitUnits: 1_000_000_000n,
      remainingUnits: 400_000_000n,
      reservedUnits: 100_000_000n,
      committedUnits: 500_000_000n,
      epoch: 3,
      revision: 7,
      breachedAt: new Date('2026-08-23T12:00:00.000Z'),
      updatedAt: new Date('2026-08-23T12:01:00.000Z'),
      reason: 'private cost-control reason',
      updatedBy: 'private-operator-id',
    })

    const response = await readMcpResource(
      db as never,
      { resource: 'ai-usage', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )

    expect(response.data).toMatchObject({
      schemaVersion: 'pathfinder.ai-usage.v2',
      scope: { clientId: 'tenant-1', venueId: 'venue-1' },
      costProtection: {
        configured: true,
        state: 'BREACHED',
        hardLimitUsd: '10.00000000',
        remainingUsd: '4.00000000',
        reservedUsd: '1.00000000',
        committedUsd: '5.00000000',
        breachedAt: '2026-08-23T12:00:00.000Z',
      },
      boundaries: {
        anomalyThresholdPolicy: 'UNRESOLVED',
        automaticBudgetMutationAuthorized: false,
        automaticServiceSuspensionAuthorized: false,
        customerPricingImpact: 'NONE',
      },
      items: [{ id: 'rollup-1', estimatedCostUsd: '0.12500000' }],
    })
    expect(db.aiCostBudget.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', coverageVersion: 'gateway-v1' },
      }),
    )
    const budgetSelect = db.aiCostBudget.findFirst.mock.calls[0]![0].select
    expect(budgetSelect).not.toHaveProperty('reason')
    expect(budgetSelect).not.toHaveProperty('updatedBy')
    expect(JSON.stringify(response)).not.toMatch(/private cost-control reason|private-operator-id/u)
  })

  it('makes an absent hard budget explicit without inventing a threshold', async () => {
    const db = database()
    db.aiUsageDailyRollup.findMany.mockResolvedValue([])
    db.aiCostBudget.findFirst.mockResolvedValue(null)

    const response = await readMcpResource(
      db as never,
      { resource: 'ai-usage', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )

    expect(response.data).toMatchObject({
      costProtection: {
        configured: false,
        coverageVersion: 'gateway-v1',
        state: 'NOT_CONFIGURED',
      },
      boundaries: { anomalyThresholdPolicy: 'UNRESOLVED' },
      items: [],
      nextCursor: null,
    })
  })

  it('returns only derived readiness evidence and never configuration blobs', async () => {
    const db = database()
    db.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      name: 'Museum',
      slug: 'museum',
      isActive: true,
      updatedAt: new Date('2026-08-11T12:00:00.000Z'),
    })
    db.place.count.mockResolvedValue(2)
    db.venueKnowledgeEntry.count.mockResolvedValue(3)
    db.venueReportConfiguration.findFirst.mockResolvedValue({ enabled: false })
    const measureNativeContentConvergence = vi.fn().mockResolvedValue({
      contractVersion: 1,
      phase: 'NATIVE_HEAD_IN_SYNC',
      guestReadPath: 'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT',
      headValid: true,
      stateMatchesHead: true,
      readyForShadowEvaluation: true,
      readyForLegacyRetirement: false,
      needsOperatorAttention: false,
      blockers: ['LEGACY_SEMANTIC_READ_PATH'],
      counts: { activePlaces: 2, enabledKnowledgeEntries: 3, publishedGeneralizedModules: 1 },
      venueActive: true,
      currentStateHash: 'a'.repeat(64),
      head: {
        releaseId: 'release-1',
        revision: 3,
        updatedAt: new Date('2026-08-11T12:00:00.000Z'),
        stateHash: 'a'.repeat(64),
        desiredStateHash: 'a'.repeat(64),
        releaseStatus: 'APPLIED',
      },
    })
    const assessNativeGuestReadActivation = vi.fn().mockResolvedValue({
      contractVersion: 1,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      runtime: { serverGateEnabled: false, production: false },
      policy: {
        present: true,
        enabled: true,
        valid: true,
        mode: 'DARK',
        targetReleaseId: 'secret-release-id',
        evaluationEvidenceId: 'secret-evidence-id',
        qualityPolicyRef: 'secret-quality-policy-reference',
        qualityPolicyReferencePresent: true,
        rollbackRehearsalRef: 'secret-rollback-reference',
        rollbackRehearsalReferencePresent: true,
        productionApprovalRef: 'secret-production-approval-reference',
        productionApprovalReferencePresent: true,
      },
      head: {
        present: true,
        valid: true,
        targetMatches: true,
        releaseId: 'secret-release-id',
      },
      evaluation: { valid: true, evidenceId: 'secret-evidence-id' },
      path: 'LEGACY',
      reason: 'SERVER_DISABLED',
      readyForConfiguredMode: false,
      nativeExecutionReady: false,
      blockers: ['SERVER_GATE_DISABLED'],
      compatibilityDataRetentionRequired: true,
      mutationPerformed: false,
    })

    const response = await readMcpResource(
      db as never,
      { resource: 'readiness', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
      {
        assessNativeGuestReadActivation: assessNativeGuestReadActivation as never,
        measureNativeContentConvergence: measureNativeContentConvergence as never,
      },
    )
    expect(response.data).toMatchObject({
      venueId: 'venue-1',
      activePlaceCount: 2,
      enabledKnowledgeCount: 3,
      readyForPreview: true,
      contentConvergence: {
        available: true,
        phase: 'NATIVE_HEAD_IN_SYNC',
        readyForShadowEvaluation: true,
        readyForLegacyRetirement: false,
      },
      nativeGuestRead: {
        available: true,
        runtime: { serverGateEnabled: false },
        policy: {
          present: true,
          enabled: true,
          valid: true,
          mode: 'DARK',
          qualityPolicyReferencePresent: true,
          rollbackRehearsalReferencePresent: true,
          productionApprovalReferencePresent: true,
        },
        head: { present: true, valid: true, targetMatches: true },
        evaluation: { valid: true },
        path: 'LEGACY',
        reason: 'SERVER_DISABLED',
        blockers: ['SERVER_GATE_DISABLED'],
        alignment: {
          runtimeReadGateOpen: false,
          materializedStateInSync: true,
          allObservedTechnicalEvidenceAligned: false,
        },
        boundaries: {
          readOnly: true,
          activationAuthorized: false,
          qualityThresholdInferred: false,
          policyReferencesExposed: false,
          compatibilityDataRetentionRequired: true,
        },
      },
    })
    expect(assessNativeGuestReadActivation).toHaveBeenCalledWith({
      client: db,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(JSON.stringify(response)).not.toMatch(
      /stateHash|desiredStateHash|release-1|secret-release|secret-evidence|secret-quality|secret-rollback|secret-production/u,
    )
    expect(db.venue.findFirst.mock.calls[0]![0].select).not.toHaveProperty('config')
  })

  it('fails the native read summary closed without hiding independent readiness evidence', async () => {
    const db = database()
    db.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      name: 'Museum',
      slug: 'museum',
      isActive: true,
      updatedAt: new Date('2026-08-11T12:00:00.000Z'),
    })
    db.place.count.mockResolvedValue(1)
    db.venueKnowledgeEntry.count.mockResolvedValue(0)
    db.venueReportConfiguration.findFirst.mockResolvedValue(null)
    const response = await readMcpResource(
      db as never,
      { resource: 'readiness', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
      {
        assessNativeGuestReadActivation: vi.fn().mockRejectedValue(new Error('contained')) as never,
        measureNativeContentConvergence: vi.fn().mockResolvedValue({
          contractVersion: 1,
          phase: 'NO_NATIVE_HEAD',
          guestReadPath: 'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT',
          headValid: false,
          stateMatchesHead: false,
          readyForShadowEvaluation: false,
          readyForLegacyRetirement: false,
          needsOperatorAttention: false,
          blockers: ['NO_NATIVE_HEAD', 'LEGACY_SEMANTIC_READ_PATH'],
          counts: { activePlaces: 1, enabledKnowledgeEntries: 0, publishedGeneralizedModules: 0 },
          venueActive: true,
          currentStateHash: 'not-returned',
          head: null,
        }) as never,
      },
    )
    expect(response.data).toMatchObject({
      readyForPreview: true,
      contentConvergence: { available: true, phase: 'NO_NATIVE_HEAD' },
      nativeGuestRead: {
        available: false,
        path: 'LEGACY',
        reason: 'ASSESSMENT_UNAVAILABLE',
        alignment: {
          runtimeReadGateOpen: false,
          materializedStateInSync: false,
          allObservedTechnicalEvidenceAligned: false,
        },
      },
    })
  })

  it('returns a versioned bounded onboarding summary without raw milestone identities', async () => {
    const db = database()
    const invitationAt = new Date(Date.now() - 60 * 60 * 1000)
    const materialAt = new Date(invitationAt.getTime() + 15 * 60 * 1000)
    db.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      name: 'Museum',
      slug: 'museum',
      isActive: false,
      updatedAt: materialAt,
    })
    db.place.count.mockResolvedValue(0)
    db.venueKnowledgeEntry.count.mockResolvedValue(0)
    db.venueReportConfiguration.findFirst.mockResolvedValue(null)
    db.onboardingMilestoneEvent.findMany.mockResolvedValue([
      {
        id: 'event-2',
        eventType: 'FIRST_USEFUL_MATERIAL',
        occurredAt: materialAt,
        category: 'PHOTO',
        durationMs: null,
      },
      {
        id: 'event-1',
        eventType: 'INVITATION_STARTED',
        occurredAt: invitationAt,
        category: null,
        durationMs: null,
      },
    ])

    const response = await readMcpResource(
      db as never,
      {
        resource: 'onboarding-summary',
        clientId: 'tenant-1',
        venueId: 'venue-1',
        limit: 25,
      },
      { credential },
    )

    expect(response.data).toMatchObject({
      schemaVersion: 'torchiko-onboarding-summary-v1',
      venueId: 'venue-1',
      milestoneRollup: {
        version: 'torchiko-onboarding-milestone-rollup-v1',
        window: { eventLimit: 1000, observedEvents: 2, truncated: false },
        timeToFirstUsefulMaterial: { valueMs: 15 * 60 * 1000, denominator: 1 },
      },
    })
    const query = db.onboardingMilestoneEvent.findMany.mock.calls[0]![0]
    expect(query.where).toMatchObject({ tenantId: 'tenant-1', venueId: 'venue-1' })
    expect(query.take).toBe(1001)
    expect(query.select).not.toHaveProperty('actorId')
    expect(query.select).not.toHaveProperty('sourceId')
    expect(query.select).not.toHaveProperty('idempotencyKey')
  })

  it('returns scoped agent questions without internal actor or execution payloads', async () => {
    const db = database()
    db.agentQuestion.findMany.mockResolvedValue([])
    await readMcpResource(
      db as never,
      { resource: 'questions', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    const query = db.agentQuestion.findMany.mock.calls[0]![0]
    expect(query.where).toMatchObject({ tenantId: 'tenant-1', venueId: 'venue-1' })
    expect(query.select).not.toHaveProperty('answeredById')
    expect(query.select).not.toHaveProperty('operationId')
  })

  it('returns scoped explicit outcomes without operation IDs or human actor identifiers', async () => {
    const db = database()
    db.agentOutcomeObservation.findMany.mockResolvedValue([])
    await readMcpResource(
      db as never,
      { resource: 'outcomes', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    const query = db.agentOutcomeObservation.findMany.mock.calls[0]![0]
    expect(query.where).toMatchObject({ tenantId: 'tenant-1', venueId: 'venue-1' })
    expect(query.select).not.toHaveProperty('operationId')
    expect(query.select).not.toHaveProperty('actorId')
    expect(query.select).not.toHaveProperty('tenantId')
    expect(query.select).not.toHaveProperty('venueId')
  })

  it('returns scoped improvement proposals without operation or reviewer identifiers', async () => {
    const db = database()
    db.agentImprovementProposal.findMany.mockResolvedValue([])
    await readMcpResource(
      db as never,
      {
        resource: 'agent-improvements',
        clientId: 'tenant-1',
        venueId: 'venue-1',
        limit: 25,
      },
      { credential },
    )
    const query = db.agentImprovementProposal.findMany.mock.calls[0]![0]
    expect(query.where).toMatchObject({ tenantId: 'tenant-1', venueId: 'venue-1' })
    expect(query.select).not.toHaveProperty('operationId')
    expect(query.select).not.toHaveProperty('createdById')
    expect(query.select).not.toHaveProperty('tenantId')
    expect(query.select).not.toHaveProperty('venueId')
    expect(query.select.validationEvidence.select).toMatchObject({
      implementationRef: true,
      implementationVersion: true,
      implementationHash: true,
      comparisonSnapshot: true,
      comparisonHash: true,
    })
    expect(query.select.validationEvidence.select).not.toHaveProperty('recordedById')
    expect(query.select.validationEvidence.select).not.toHaveProperty('operationId')
    expect(query.select.validationEvidence.select).not.toHaveProperty('approvalDecision')
  })

  it('adds privacy-bounded operational intelligence without selecting secrets or raw payloads', async () => {
    const db = database()
    for (const delegate of [
      db.weeklyReport,
      db.visitorSession,
      db.externalAccessCredential,
      db.agentRun,
      db.agentAction,
      db.agentTimelineEvent,
      db.approvalRequest,
      db.agentOutcomeObservation,
      db.operationalEvent,
      db.nativeVenueDeploymentRelease,
      db.tenantFeatureFlag,
    ]) {
      delegate.findMany.mockResolvedValue([])
    }
    for (const resource of [
      'reports',
      'conversations',
      'integrations',
      'agent-runs',
      'agent-run-trace',
      'events',
      'deployments',
    ] as const) {
      if (resource === 'agent-run-trace') db.agentRun.findFirst.mockResolvedValue({ id: 'run-1' })
      await readMcpResource(
        db as never,
        {
          resource,
          clientId: 'tenant-1',
          venueId: 'venue-1',
          ...(resource === 'agent-run-trace' ? { agentRunId: 'run-1' } : {}),
          limit: 25,
        },
        { credential },
      )
    }
    await readMcpResource(
      db as never,
      { resource: 'feature-flags', clientId: 'tenant-1', limit: 25 },
      { credential },
    )

    expect(db.weeklyReport.findMany.mock.calls[0]![0].select).not.toHaveProperty('content')
    expect(db.weeklyReport.findMany.mock.calls[0]![0].select).not.toHaveProperty('error')
    expect(db.visitorSession.findMany.mock.calls[0]![0].select).not.toHaveProperty('anonymousToken')
    expect(db.visitorSession.findMany.mock.calls[0]![0].select).not.toHaveProperty('visitorId')
    expect(db.visitorSession.findMany.mock.calls[0]![0].select).not.toHaveProperty('latestLat')
    expect(db.externalAccessCredential.findMany.mock.calls[0]![0].select).not.toHaveProperty(
      'secretHash',
    )
    expect(db.externalAccessCredential.findMany.mock.calls[0]![0].select).not.toHaveProperty(
      'secretPrefix',
    )
    expect(db.agentAction.findMany.mock.calls[0]![0].select).not.toHaveProperty('inputReference')
    expect(db.agentAction.findMany.mock.calls[0]![0].select).not.toHaveProperty('output')
    expect(db.agentTimelineEvent.findMany.mock.calls[0]![0].select).not.toHaveProperty('data')
    expect(db.approvalRequest.findMany.mock.calls[0]![0].select).not.toHaveProperty('scopeSnapshot')
    expect(db.agentRun.findMany.mock.calls[0]![0].select).not.toHaveProperty('requestPrompt')
    expect(db.agentRun.findMany.mock.calls[0]![0].select).not.toHaveProperty('scopeSnapshot')
    expect(db.agentRun.findMany.mock.calls[0]![0].select).not.toHaveProperty('artifacts')
    expect(db.nativeVenueDeploymentRelease.findMany.mock.calls[0]![0].select).not.toHaveProperty(
      'plan',
    )
    expect(db.tenantFeatureFlag.findMany.mock.calls[0]![0].select).not.toHaveProperty('metadata')
    expect(db.tenantFeatureFlag.findMany.mock.calls[0]![0].select).not.toHaveProperty('setBy')
    for (const delegate of [
      db.weeklyReport,
      db.visitorSession,
      db.agentRun,
      db.operationalEvent,
      db.nativeVenueDeploymentRelease,
    ]) {
      expect(delegate.findMany.mock.calls[0]![0].where).toMatchObject({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
      })
    }
    expect(db.externalAccessCredential.findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: 'tenant-1',
      clientId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(db.tenantFeatureFlag.findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: 'tenant-1',
    })
  })

  it('merges one exact agent run trace and pages equal-time evidence without exposing authority', async () => {
    const db = database()
    const at = (value: string) => new Date(value)
    db.agentRun.findFirst.mockResolvedValue({ id: 'run-1' })
    db.agentAction.findMany.mockResolvedValue([
      {
        id: 'action-1',
        createdAt: at('2026-08-23T12:00:00.000Z'),
        actorType: 'AGENT',
        actorId: 'agent-1',
        actionName: 'support.prepare',
        costE8Usd: 25_000_000n,
        status: 'SUCCEEDED',
      },
    ])
    db.agentTimelineEvent.findMany.mockResolvedValue([
      {
        id: 'event-1',
        createdAt: at('2026-08-23T12:03:00.000Z'),
        actorType: 'SYSTEM',
        actorId: 'runtime',
        eventType: 'RUN_COMPLETED',
      },
    ])
    db.approvalRequest.findMany.mockResolvedValue([
      {
        id: 'approval-1',
        createdAt: at('2026-08-23T12:01:00.000Z'),
        requestedByType: 'AGENT',
        requestedById: 'agent-1',
        proposedAction: 'support.publish',
        reason: 'External effect',
        riskCategory: 'HIGH',
        expiresAt: null,
        decision: {
          decision: 'APPROVED',
          reason: 'Reviewed',
          createdAt: at('2026-08-23T12:02:00.000Z'),
        },
      },
    ])
    db.agentOutcomeObservation.findMany.mockResolvedValue([
      {
        id: 'outcome-1',
        createdAt: at('2026-08-23T12:02:00.000Z'),
        actorType: 'HUMAN',
        actorId: 'operator-1',
        signalKind: 'HUMAN_REVIEW',
        verdict: 'POSITIVE',
        summary: 'Useful result.',
      },
    ])

    const response = await readMcpResource(
      db as never,
      {
        resource: 'agent-run-trace',
        clientId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        limit: 3,
      },
      { credential },
    )
    const data = response.data as {
      items: Array<Record<string, unknown>>
      nextCursor: string
      excludes: string[]
    }
    expect(data.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'EVENT:event-1',
      'OUTCOME:outcome-1',
      'APPROVAL:approval-1',
    ])
    expect(data.items[1]).toMatchObject({ createdAt: '2026-08-23T12:02:00.000Z' })
    expect(data.items[2]).toMatchObject({
      decision: { decision: 'APPROVED', createdAt: '2026-08-23T12:02:00.000Z' },
    })
    expect(data.excludes).toContain('EXECUTION_LEASE')

    db.agentAction.findMany.mockResolvedValue([])
    db.agentTimelineEvent.findMany.mockResolvedValue([])
    db.approvalRequest.findMany.mockResolvedValue([])
    db.agentOutcomeObservation.findMany.mockResolvedValue([])
    await readMcpResource(
      db as never,
      {
        resource: 'agent-run-trace',
        clientId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'run-1',
        cursor: data.nextCursor,
        limit: 3,
      },
      { credential },
    )
    expect(db.agentTimelineEvent.findMany.mock.calls[1]![0].where.OR).toEqual([
      { createdAt: { lt: at('2026-08-23T12:01:00.000Z') } },
    ])
    expect(db.agentAction.findMany.mock.calls[1]![0].where.OR).toEqual([
      { createdAt: { lt: at('2026-08-23T12:01:00.000Z') } },
      { createdAt: at('2026-08-23T12:01:00.000Z') },
    ])
    expect(db.approvalRequest.findMany.mock.calls[1]![0].where.OR).toEqual([
      { createdAt: { lt: at('2026-08-23T12:01:00.000Z') } },
      { createdAt: at('2026-08-23T12:01:00.000Z'), id: { lt: 'approval-1' } },
    ])
  })
})
