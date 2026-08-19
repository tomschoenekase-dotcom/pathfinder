import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
  emitEvent: vi.fn(),
  generateText: vi.fn(),
  resolveDeterministic: vi.fn(),
  assertVenueAiAvailable: vi.fn(),
  reserveTurn: vi.fn(),
  claimTurn: vi.fn(),
  markProviderDispatched: vi.fn(),
  completeTurn: vi.fn(),
  setPreference: vi.fn(),
  createSupportRequest: vi.fn(),
  linkHandoff: vi.fn(),
  usageSink: vi.fn(),
  budgetGate: vi.fn(),
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
  generateText: mocks.generateText,
  resolveDeterministicClientTochiResponse: mocks.resolveDeterministic,
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  assertVenueAiAvailable: mocks.assertVenueAiAvailable,
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

describe('clientAssistant router', () => {
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
    expect(mocks.generateText).not.toHaveBeenCalled()
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
    expect(mocks.generateText).not.toHaveBeenCalled()
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
    expect(mocks.generateText).not.toHaveBeenCalled()
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
    expect(mocks.generateText).not.toHaveBeenCalled()
    expect(mocks.completeTurn).not.toHaveBeenCalled()
  })

  it('claims before model dispatch and persists the bounded fallback on provider failure', async () => {
    mocks.resolveDeterministic.mockReturnValue(null)
    mocks.generateText.mockImplementation(
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

    expect(mocks.claimTurn.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.generateText.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    const claimInput = mocks.claimTurn.mock.calls[0]?.[0]
    expect(claimInput.generationLeaseId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKey: 'client-tochi',
        invocationId: claimInput.generationLeaseId,
      }),
    )
    expect(mocks.markProviderDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ generationLeaseId: claimInput.generationLeaseId }),
      mockDb,
    )
    expect(mocks.completeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        generationLeaseId: claimInput.generationLeaseId,
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
    expect(JSON.stringify(result)).not.toContain('assistant-unavailable')
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
