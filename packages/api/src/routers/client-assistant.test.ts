import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
  emitEvent: vi.fn(),
  generateTextForCapability: vi.fn(),
  resolveDeterministic: vi.fn(),
  routeAiCapability: vi.fn(),
  resolveConfiguration: vi.fn(),
  assertVenueAiAvailable: vi.fn(),
  reserveTurn: vi.fn(),
  claimTurn: vi.fn(),
  markProviderDispatched: vi.fn(),
  completeTurn: vi.fn(),
  setPreference: vi.fn(),
  createSupportRequest: vi.fn(),
  linkHandoff: vi.fn(),
  usageSink: vi.fn(),
  budgetGate: {
    reserve: vi.fn(),
    markDispatched: vi.fn(),
    settleExact: vi.fn(),
    settleAmbiguous: vi.fn(),
    releaseUndispatched: vi.fn(),
  },
}))

vi.mock('@pathfinder/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/config')>()),
  isFeatureEnabled: mocks.isFeatureEnabled,
}))

vi.mock('@pathfinder/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/analytics')>()),
  emitEvent: mocks.emitEvent,
}))

vi.mock('@pathfinder/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/ai')>()),
  generateTextForCapability: mocks.generateTextForCapability,
  resolveDeterministicClientTochiResponse: mocks.resolveDeterministic,
  routeAiCapability: mocks.routeAiCapability,
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  assertVenueAiAvailable: mocks.assertVenueAiAvailable,
  resolveRuntimeAiWorkloadConfiguration: mocks.resolveConfiguration,
  reserveClientAssistantTurnAction: mocks.reserveTurn,
  claimClientAssistantTurnGenerationAction: mocks.claimTurn,
  markClientAssistantTurnProviderDispatchedAction: mocks.markProviderDispatched,
  completeClientAssistantTurnAction: mocks.completeTurn,
  setClientAssistantPreferenceAction: mocks.setPreference,
  createSupportRequestAction: mocks.createSupportRequest,
  linkClientAssistantSupportHandoffAction: mocks.linkHandoff,
}))

vi.mock('../lib/api-ai-usage', () => ({
  createApiAiUsageRecorder: () => ({
    sink: mocks.usageSink,
    budgetGate: mocks.budgetGate,
  }),
}))

import { ClientAssistantActionError } from '@pathfinder/db'
import { setAnthropicClientForTesting, type AnthropicMessagesClient } from '@pathfinder/ai'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { clientAssistantRouter } from './client-assistant'

const tenantFeatureFlagFindUnique = vi.fn()
const preferenceFindUnique = vi.fn()
const venueFindMany = vi.fn()
const venueFindFirst = vi.fn()
const turnFindMany = vi.fn()
const turnFindFirst = vi.fn()
const intakeRunCount = vi.fn()
const mediaProjectGroupBy = vi.fn()
const venuePackageGroupBy = vi.fn()
const contentVersionFindFirst = vi.fn()
const offboardingTargetFindFirst = vi.fn()
const intakeUploadCount = vi.fn()
const intakeUploadFindMany = vi.fn()
const agentQuestionCount = vi.fn()

const mockDb = {
  $transaction: vi.fn(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb)),
  tenantFeatureFlag: { findUnique: tenantFeatureFlagFindUnique },
  clientAssistantPreference: { findUnique: preferenceFindUnique },
  clientAssistantTurn: { findMany: turnFindMany, findFirst: turnFindFirst },
  venue: { findMany: venueFindMany, findFirst: venueFindFirst },
  intakeRun: { count: intakeRunCount },
  mediaIngestionProject: { groupBy: mediaProjectGroupBy },
  venuePackage: { groupBy: venuePackageGroupBy },
  contentVersion: { findFirst: contentVersionFindFirst },
  offboardingVenueTarget: { findFirst: offboardingTargetFindFirst },
  intakeUpload: { count: intakeUploadCount, findMany: intakeUploadFindMany },
  agentQuestion: { count: agentQuestionCount },
} as unknown as TRPCContext['db']

const ctx: TRPCContext = {
  db: mockDb,
  headers: new Headers(),
  session: {
    userId: 'user-1',
    activeTenantId: 'tenant-1',
    role: 'STAFF',
    isPlatformAdmin: false,
  },
}

const testRouter = router({ clientAssistant: clientAssistantRouter })
const caller = () => testRouter.createCaller(ctx).clientAssistant
const venueId = 'venue-1'
const operationId = '11111111-1111-4111-8111-111111111111'
const createdAt = new Date('2026-08-19T12:00:00.000Z')

const reservedTurn = {
  id: 'turn-1',
  tenantId: 'tenant-1',
  venueId,
  threadId: 'thread-1',
  operationHash: 'internal-hash',
  status: 'RESERVED',
  behaviorVersion: '2026-08-19.v1',
  userMessage: 'Where should I upload photos?',
  assistantMessage: null,
  questionCategory: null,
  safeActions: [],
  failureCode: null,
  revision: 1,
  createdAt,
  completedAt: null,
  thread: { userId: 'user-1' },
}

const contextVenue = {
  id: venueId,
  name: 'Test Venue',
  isActive: true,
  tonePreset: 'friendly',
  venueBotConfiguration: { presentationMode: 'CLASSIC' },
  _count: { places: 0, knowledgeEntries: 0 },
}

const clientTochiConfiguration = {
  configurationVersion: 'ai-workload-config-v1',
  workloadId: 'client-tochi',
  kind: 'TEXT',
  primaryModelKey: 'client-tochi',
  fallback: { enabled: true, modelKeys: ['guest-chat'] },
  timeoutMs: 4_321,
  maxAttempts: 2,
  maxOutputTokens: 321,
  requestBudgetCeilingE8Usd: '1234',
  model: {},
  sources: {},
}

const clientTochiRoute = {
  capability: 'FAST',
  workloadId: 'client-tochi',
  configurationVersion: 'ai-workload-config-v1',
  candidates: [],
  latencyPreference: 'BALANCED',
  qualityPreference: 'BALANCED',
}

describe('clientAssistant router', () => {
  afterEach(() => setAnthropicClientForTesting(null))

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isFeatureEnabled.mockImplementation((key: string) => key === 'clientTochi')
    mocks.emitEvent.mockResolvedValue(undefined)
    tenantFeatureFlagFindUnique.mockResolvedValue({ enabled: true })
    preferenceFindUnique.mockResolvedValue(null)
    venueFindMany.mockResolvedValue([{ id: venueId, name: 'Test Venue' }])
    venueFindFirst.mockResolvedValue(contextVenue)
    turnFindMany.mockResolvedValue([])
    turnFindFirst.mockResolvedValue(null)
    intakeRunCount.mockResolvedValue(0)
    mediaProjectGroupBy.mockResolvedValue([])
    venuePackageGroupBy.mockResolvedValue([])
    contentVersionFindFirst.mockResolvedValue(null)
    offboardingTargetFindFirst.mockResolvedValue(null)
    intakeUploadCount.mockResolvedValue(0)
    intakeUploadFindMany.mockResolvedValue([])
    agentQuestionCount.mockResolvedValue(0)
    mocks.reserveTurn.mockResolvedValue({ turn: reservedTurn, replayed: false })
    mocks.claimTurn.mockResolvedValue({
      claim: { id: 'turn-1', status: 'GENERATING', revision: 2 },
      replayed: false,
    })
    mocks.markProviderDispatched.mockResolvedValue({ replayed: false })
    mocks.completeTurn.mockResolvedValue({ replayed: false })
    mocks.assertVenueAiAvailable.mockResolvedValue(undefined)
    mocks.resolveConfiguration.mockResolvedValue(clientTochiConfiguration)
    mocks.routeAiCapability.mockReturnValue(clientTochiRoute)
    mocks.budgetGate.reserve.mockResolvedValue(null)
    mocks.budgetGate.markDispatched.mockResolvedValue(undefined)
    mocks.budgetGate.settleExact.mockResolvedValue(undefined)
    mocks.budgetGate.settleAmbiguous.mockResolvedValue(undefined)
    mocks.budgetGate.releaseUndispatched.mockResolvedValue(undefined)
    mocks.setPreference.mockResolvedValue({
      enabled: true,
      minimized: false,
      revision: 1,
      updatedAt: createdAt,
    })
  })

  it('fails closed with an inert, safe bootstrap when the global flag is off', async () => {
    mocks.isFeatureEnabled.mockReturnValue(false)

    await expect(caller().bootstrap({ venueId })).resolves.toEqual({
      available: false,
      venues: [],
      selectedVenueId: null,
      preference: { enabled: false, minimized: false, revision: 0 },
      history: [],
    })
    expect(tenantFeatureFlagFindUnique).not.toHaveBeenCalled()
    expect(venueFindMany).not.toHaveBeenCalled()
  })

  it('also fails closed when the tenant rollout is absent', async () => {
    tenantFeatureFlagFindUnique.mockResolvedValue(null)

    const result = await caller().bootstrap({})

    expect(result.available).toBe(false)
    expect(tenantFeatureFlagFindUnique).toHaveBeenCalledWith({
      where: { tenantId_flagKey: { tenantId: 'tenant-1', flagKey: 'client-tochi-v1' } },
      select: { enabled: true },
    })
    expect(venueFindMany).not.toHaveBeenCalled()
  })

  it('honors an explicit preference-off state before reserving or dispatching', async () => {
    preferenceFindUnique.mockResolvedValue({ enabled: false })

    await expect(
      caller().send({ operationId, venueId, message: 'Where should I upload photos?' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Tochi assistance is turned off' })
    expect(mocks.reserveTurn).not.toHaveBeenCalled()
    expect(mocks.generateTextForCapability).not.toHaveBeenCalled()
  })

  it('rejects a cross-tenant venue during reservation before any provider work', async () => {
    mocks.reserveTurn.mockRejectedValue(
      new ClientAssistantActionError('NOT_FOUND', 'Client assistant is not available'),
    )

    await expect(
      caller().send({ operationId, venueId: 'foreign-venue', message: 'Can you help?' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.reserveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', venueId: 'foreign-venue' }),
      mockDb,
    )
    expect(mocks.claimTurn).not.toHaveBeenCalled()
    expect(mocks.generateTextForCapability).not.toHaveBeenCalled()
  })

  it('completes deterministic guidance without invoking a model', async () => {
    mocks.resolveDeterministic.mockReturnValue({
      answer: 'Use the Information page to add those photos.',
      category: 'upload-guidance',
      action: { type: 'navigate', routeKey: 'information', label: 'Open Information' },
    })

    const result = await caller().send({
      operationId,
      venueId,
      message: 'Where should I upload photos?',
    })

    expect(mocks.claimTurn).toHaveBeenCalledOnce()
    expect(mocks.generateTextForCapability).not.toHaveBeenCalled()
    expect(mocks.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId,
        turnId: 'turn-1',
        expectedRevision: 2,
        assistantMessage: 'Use the Information page to add those photos.',
        questionCategory: 'upload-guidance',
        safeActions: [{ type: 'navigate', href: '/information', label: 'Open Information' }],
        outcome: { status: 'COMPLETED' },
      }),
      mockDb,
    )
    expect(result).toEqual({
      id: 'turn-1',
      threadId: 'thread-1',
      answer: 'Use the Information page to add those photos.',
      category: 'upload-guidance',
      action: { type: 'navigate', href: '/information', label: 'Open Information' },
      replayed: false,
    })
    expect(JSON.stringify(result)).not.toMatch(
      /tenantId|operationHash|generationLease|failureCode|provider/iu,
    )
  })

  it('returns an exact completed replay without claiming or regenerating', async () => {
    mocks.reserveTurn.mockResolvedValue({
      replayed: true,
      turn: {
        ...reservedTurn,
        status: 'COMPLETED',
        assistantMessage: 'Open the Information page.',
        questionCategory: 'portal-navigation',
        safeActions: [{ type: 'navigate', href: '/information', label: 'Open Information' }],
        completedAt: createdAt,
      },
    })

    const result = await caller().send({
      operationId,
      venueId,
      message: 'Where should I upload photos?',
    })

    expect(result).toEqual({
      id: 'turn-1',
      threadId: 'thread-1',
      answer: 'Open the Information page.',
      category: 'portal-navigation',
      action: { type: 'navigate', href: '/information', label: 'Open Information' },
      replayed: true,
    })
    expect(mocks.claimTurn).not.toHaveBeenCalled()
    expect(mocks.generateTextForCapability).not.toHaveBeenCalled()
    expect(mocks.completeTurn).not.toHaveBeenCalled()
  })

  it('routes configured Client Tochi generation through stable admission and preserves safe projection', async () => {
    mocks.resolveDeterministic.mockReturnValue(null)
    mocks.generateTextForCapability.mockImplementation(
      async (input: {
        admissionGuard: () => Promise<void>
        onBeforeFirstDispatch: () => Promise<void>
        budgetGate: { reserve: (attempt: { reservedUnits: bigint }) => Promise<unknown> }
      }) => {
        await input.admissionGuard()
        await expect(input.budgetGate.reserve({ reservedUnits: 1_235n })).rejects.toMatchObject({
          code: 'REQUEST_BUDGET_CEILING_EXCEEDED',
        })
        await input.onBeforeFirstDispatch()
        return {
          parsed: {
            answer: 'Upload the photo from the Information page.',
            category: 'upload-guidance',
            action: { type: 'navigate', routeKey: 'information', label: 'Open Information' },
          },
        }
      },
    )

    const result = await caller().send({ operationId, venueId, message: 'A novel question' })

    expect(mocks.claimTurn.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.generateTextForCapability.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    const claimInput = mocks.claimTurn.mock.calls[0]?.[0]
    expect(claimInput.generationLeaseId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(mocks.resolveConfiguration).toHaveBeenCalledWith(
      { workloadId: 'client-tochi', tenantId: 'tenant-1', venueId },
      mockDb,
    )
    expect(mocks.routeAiCapability).toHaveBeenCalledWith({
      capability: 'FAST',
      workloadId: 'client-tochi',
      configuration: clientTochiConfiguration,
    })
    expect(mocks.generateTextForCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        route: clientTochiRoute,
        invocationId: claimInput.generationLeaseId,
        timeoutMs: 4_321,
        maxAttempts: 2,
        maxOutputTokens: 321,
      }),
    )
    expect(mocks.markProviderDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ generationLeaseId: claimInput.generationLeaseId }),
      mockDb,
    )
    expect(mocks.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        generationLeaseId: claimInput.generationLeaseId,
        outcome: { status: 'COMPLETED' },
        questionCategory: 'upload-guidance',
      }),
      mockDb,
    )
    expect(result).toMatchObject({
      answer: 'Upload the photo from the Information page.',
      category: 'upload-guidance',
      action: { type: 'navigate', href: '/information', label: 'Open Information' },
      replayed: false,
    })
    expect(JSON.stringify(result)).not.toContain('assistant-unavailable')
  })

  it('persists the bounded fallback when configured generation fails after dispatch', async () => {
    mocks.resolveDeterministic.mockReturnValue(null)
    mocks.generateTextForCapability.mockImplementation(
      async (input: {
        admissionGuard: () => Promise<void>
        onBeforeFirstDispatch: () => Promise<void>
      }) => {
        await input.admissionGuard()
        await input.onBeforeFirstDispatch()
        throw new Error('provider unavailable')
      },
    )

    const result = await caller().send({ operationId, venueId, message: 'A novel question' })

    expect(mocks.markProviderDispatched).toHaveBeenCalledOnce()
    expect(mocks.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { status: 'FAILED', failureCode: 'assistant-unavailable' },
        questionCategory: 'general-help',
      }),
      mockDb,
    )
    expect(result).toMatchObject({
      answer: expect.stringContaining('could not check that right now'),
      category: 'general-help',
      action: { type: 'navigate', href: '/support' },
      replayed: false,
    })
  })

  it('does not dispatch when the effective configuration changes after turn claim', async () => {
    mocks.resolveDeterministic.mockReturnValue(null)
    mocks.resolveConfiguration
      .mockResolvedValueOnce(clientTochiConfiguration)
      .mockResolvedValueOnce({ ...clientTochiConfiguration, maxAttempts: 1 })
    mocks.generateTextForCapability.mockImplementation(
      async (input: { admissionGuard: () => Promise<void> }) => {
        await input.admissionGuard()
        throw new Error('unreachable')
      },
    )

    const result = await caller().send({ operationId, venueId, message: 'A novel question' })

    expect(mocks.markProviderDispatched).not.toHaveBeenCalled()
    expect(mocks.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { status: 'FAILED', failureCode: 'assistant-unavailable' },
      }),
      mockDb,
    )
    expect(result).toMatchObject({ category: 'general-help', replayed: false })
  })

  it('stops a retry when the effective configuration changes and retains one dispatch fence', async () => {
    mocks.resolveDeterministic.mockReturnValue(null)
    mocks.resolveConfiguration
      .mockResolvedValueOnce(clientTochiConfiguration)
      .mockResolvedValueOnce(clientTochiConfiguration)
      .mockResolvedValueOnce(clientTochiConfiguration)
      .mockResolvedValueOnce({ ...clientTochiConfiguration, requestBudgetCeilingE8Usd: '1000' })
    mocks.generateTextForCapability.mockImplementation(
      async (input: {
        admissionGuard: () => Promise<void>
        onBeforeFirstDispatch: () => Promise<void>
      }) => {
        await input.admissionGuard()
        await input.admissionGuard()
        await input.onBeforeFirstDispatch()
        await input.admissionGuard()
        throw new Error('unreachable retry')
      },
    )

    await caller().send({ operationId, venueId, message: 'A novel question' })

    expect(mocks.markProviderDispatched).toHaveBeenCalledOnce()
    expect(mocks.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { status: 'FAILED', failureCode: 'assistant-unavailable' },
      }),
      mockDb,
    )
  })

  it('uses the actual configured fallback under one lease dispatch after a dark primary 503', async () => {
    mocks.resolveDeterministic.mockReturnValue(null)
    const ai = await vi.importActual<typeof import('@pathfinder/ai')>('@pathfinder/ai')
    const configuration = ai.resolveAiWorkloadConfiguration({
      workloadId: 'client-tochi',
      clientId: 'tenant-1',
      venueId,
      overrides: [
        {
          activation: 'ENABLED',
          scope: { level: 'VENUE', clientId: 'tenant-1', venueId, workloadId: 'client-tochi' },
          values: {
            fallback: { enabled: true, modelKeys: ['guest-chat'] },
            maxAttempts: 1,
          },
          unsafeChangesEnabled: true,
          reason: 'bounded configured fallback fixture',
        },
      ],
    })
    mocks.resolveConfiguration.mockResolvedValue(configuration)
    mocks.routeAiCapability.mockImplementation(ai.routeAiCapability)
    mocks.generateTextForCapability.mockImplementation(ai.generateTextForCapability)
    const providerCreate = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('primary unavailable'), { status: 503 }))
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              answer: 'Use the Information page to update those details.',
              category: 'general-help',
              action: { type: 'navigate', routeKey: 'information', label: 'Open Information' },
            }),
          },
        ],
        usage: { input_tokens: 12, output_tokens: 8 },
      })
    setAnthropicClientForTesting({
      messages: { create: providerCreate },
    } as AnthropicMessagesClient)

    const result = await caller().send({ operationId, venueId, message: 'A novel question' })

    expect(providerCreate).toHaveBeenCalledTimes(2)
    expect(mocks.markProviderDispatched).toHaveBeenCalledOnce()
    expect(mocks.markProviderDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ generationLeaseId: expect.any(String) }),
      mockDb,
    )
    expect(result).toMatchObject({
      answer: 'Use the Information page to update those details.',
      category: 'general-help',
      action: { type: 'navigate', href: '/information', label: 'Open Information' },
      replayed: false,
    })
  })

  it('rejects a tampered handoff preview before creating any support record', async () => {
    turnFindFirst.mockResolvedValue({
      id: 'turn-1',
      threadId: 'thread-1',
      safeActions: [
        {
          type: 'preview-support-handoff',
          category: 'GENERAL',
          summary: 'Approved summary',
          requestedOutcome: 'Approved outcome',
        },
      ],
    })

    await expect(
      caller().confirmHandoff({
        operationId,
        venueId,
        turnId: 'turn-1',
        category: 'GENERAL',
        summary: 'Tampered summary',
        requestedOutcome: 'Approved outcome',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.createSupportRequest).not.toHaveBeenCalled()
    expect(mocks.linkHandoff).not.toHaveBeenCalled()
  })

  it('creates confirmed support provenance from the exact saved preview', async () => {
    const preview = {
      type: 'preview-support-handoff',
      category: 'BRANDING',
      summary: 'Update the venue logo',
      requestedOutcome: 'Replace the old logo after team review.',
      relevantFeature: 'Header branding',
    } as const
    turnFindFirst.mockResolvedValue({
      id: 'turn-1',
      threadId: 'thread-1',
      safeActions: [preview],
    })
    turnFindMany.mockResolvedValue([
      {
        userMessage: 'Please change our old logo.',
        assistantMessage: 'I can prepare that request.',
      },
    ])
    mocks.createSupportRequest.mockResolvedValue({
      request: { id: 'support-1' },
      replayed: false,
    })
    mocks.linkHandoff.mockResolvedValue({
      handoff: { id: 'handoff-1' },
      replayed: false,
    })

    const result = await caller().confirmHandoff({
      operationId,
      venueId,
      turnId: 'turn-1',
      category: preview.category,
      summary: preview.summary,
      requestedOutcome: preview.requestedOutcome,
      relevantFeature: preview.relevantFeature,
    })

    expect(mocks.createSupportRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        tenantId: 'tenant-1',
        venueId,
        category: 'BRANDING',
        subject: preview.summary,
        actor: expect.objectContaining({ actorId: 'user-1', participantKind: 'CLIENT' }),
      }),
      mockDb,
    )
    expect(mocks.linkHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        tenantId: 'tenant-1',
        venueId,
        turnId: 'turn-1',
        supportRequestId: 'support-1',
        summarySnapshot: {
          schemaVersion: 1,
          source: 'CLIENT_TOCHI',
          category: 'BRANDING',
          summary: preview.summary,
          requestedOutcome: preview.requestedOutcome,
          relevantFeature: preview.relevantFeature,
          excerpt: [
            { role: 'user', content: 'Please change our old logo.' },
            { role: 'assistant', content: 'I can prepare that request.' },
          ],
        },
        actor: { userId: 'user-1', auditRole: 'STAFF' },
      }),
      mockDb,
    )
    expect(result).toEqual({ requestId: 'support-1', handoffId: 'handoff-1', replayed: false })
  })

  it('scopes opened and preference mutations to the active tenant and actor', async () => {
    await expect(caller().opened({ venueId })).resolves.toEqual({ ok: true })
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: venueId, tenantId: 'tenant-1', isActive: true },
      select: { id: true },
    })

    await caller().setPreference({
      venueId,
      enabled: true,
      minimized: false,
      expectedRevision: 0,
    })
    expect(mocks.setPreference).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        enabled: true,
        minimized: false,
        expectedRevision: 0,
        actor: { userId: 'user-1', auditRole: 'STAFF' },
      },
      mockDb,
    )
  })
})
