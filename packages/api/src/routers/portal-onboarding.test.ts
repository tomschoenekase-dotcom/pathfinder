import { describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { portalRouter } from './portal'

const venueFindFirst = vi.fn()
const uploadGroupBy = vi.fn()
const intakeGroupBy = vi.fn()
const mediaGroupBy = vi.fn()
const packageGroupBy = vi.fn()
const packageFindFirst = vi.fn()
const historyFindFirst = vi.fn()
const offboardingFindFirst = vi.fn()
const supportCount = vi.fn()
const supportFindMany = vi.fn()
const evalRunFindFirst = vi.fn()
const evalResultFindMany = vi.fn()

const app = router({ portal: portalRouter })
const ctx = {
  db: {
    $transaction: vi.fn(async (callback: (db: unknown) => unknown) => callback(ctx.db)),
    venue: { findFirst: venueFindFirst },
    intakeUpload: { groupBy: uploadGroupBy },
    intakeRun: { groupBy: intakeGroupBy },
    mediaIngestionProject: { groupBy: mediaGroupBy },
    venuePackage: { groupBy: packageGroupBy, findFirst: packageFindFirst },
    contentVersion: { findFirst: historyFindFirst },
    offboardingVenueTarget: { findFirst: offboardingFindFirst },
    supportRequest: { count: supportCount, findMany: supportFindMany },
    evalRun: { findFirst: evalRunFindFirst },
    evalResult: { findMany: evalResultFindMany },
  } as unknown as TRPCContext['db'],
  headers: new Headers(),
  session: {
    userId: 'user-1',
    activeTenantId: 'tenant-1',
    role: 'MANAGER' as const,
    isPlatformAdmin: false,
  },
}

function setEmptyJourney() {
  venueFindFirst.mockResolvedValue({
    id: 'venue-1',
    name: 'Museum',
    isActive: false,
    _count: { places: 0, knowledgeEntries: 0 },
  })
  uploadGroupBy.mockResolvedValue([])
  intakeGroupBy.mockResolvedValue([])
  mediaGroupBy.mockResolvedValue([])
  packageGroupBy.mockResolvedValue([])
  packageFindFirst.mockResolvedValue(null)
  historyFindFirst.mockResolvedValue(null)
  offboardingFindFirst.mockResolvedValue(null)
  supportCount.mockResolvedValue(0)
  supportFindMany.mockResolvedValue([])
  evalRunFindFirst.mockResolvedValue(null)
  evalResultFindMany.mockResolvedValue([])
}

describe('remote onboarding journey read model', () => {
  it('returns a bounded website-first journey without internal evidence or publish authority', async () => {
    setEmptyJourney()

    const result = await app.createCaller(ctx).portal.getOnboardingJourney({ venueId: 'venue-1' })

    expect(ctx.db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    })
    expect(uploadGroupBy).toHaveBeenCalledWith({
      by: ['status', 'category'],
      where: { tenantId: 'tenant-1', venueId: 'venue-1' },
      _count: { _all: true },
    })
    expect(result).toMatchObject({
      venue: { id: 'venue-1', name: 'Museum' },
      projection: { primaryAction: { stage: 'MATERIALS', label: 'Start with my website' } },
      questions: { open: 0, items: [], additionalQuestionCount: 0 },
      publication: { clientCanPublish: false },
    })
    expect(JSON.stringify(result)).not.toMatch(
      /objectKey|sha256|confidenceScore|modelSnapshot|caseSnapshot|approvalCommand|evidenceRecord/iu,
    )
    for (const call of [
      uploadGroupBy,
      intakeGroupBy,
      mediaGroupBy,
      packageGroupBy,
      historyFindFirst,
      offboardingFindFirst,
      supportCount,
      supportFindMany,
      packageFindFirst,
    ]) {
      expect(call.mock.calls[0]?.[0]).toMatchObject({
        where: { tenantId: 'tenant-1', venueId: 'venue-1' },
      })
    }
    expect(evalRunFindFirst).not.toHaveBeenCalled()
  })

  it('prioritizes accessible questions and reports frozen QA outcomes independently', async () => {
    setEmptyJourney()
    uploadGroupBy.mockResolvedValue([
      { status: 'AWAITING_REVIEW', category: 'PHOTO', _count: { _all: 2 } },
      { status: 'REJECTED', category: 'OTHER', _count: { _all: 1 } },
    ])
    intakeGroupBy.mockResolvedValue([{ status: 'AWAITING_REVIEW', _count: { _all: 2 } }])
    supportCount.mockResolvedValue(1)
    supportFindMany.mockResolvedValue([
      {
        id: 'request-1',
        subject: 'Accessible entrance',
        missingInformation: ['Which entrance has a step-free route?', 'Is it open every day?'],
      },
    ])
    packageFindFirst
      .mockResolvedValueOnce({ id: 'package-1', payloadHash: 'a'.repeat(64) })
      .mockResolvedValue({ id: 'package-1', approvedAt: null })
    evalRunFindFirst.mockResolvedValue({ id: 'run-1', status: 'COMPLETED' })
    evalResultFindMany.mockResolvedValue([
      { outcome: 'SCORED', passed: true, evalCase: { caseKey: 'onboarding-fact-approved' } },
      {
        outcome: 'SCORED',
        passed: true,
        evalCase: { caseKey: 'onboarding-navigation-approved' },
      },
      {
        outcome: 'SCORED',
        passed: false,
        evalCase: { caseKey: 'onboarding-accessibility-approved' },
      },
      { outcome: 'SCORED', passed: true, evalCase: { caseKey: 'onboarding-safety-approved' } },
      {
        outcome: 'SCORED',
        passed: true,
        evalCase: { caseKey: 'onboarding-multilingual-approved' },
      },
      {
        outcome: 'SCORED',
        passed: false,
        evalCase: { caseKey: 'onboarding-adversarial-approved' },
      },
      {
        outcome: 'OPERATIONAL_FAILURE',
        passed: null,
        evalCase: { caseKey: 'onboarding-unanswerable-approved' },
      },
    ])

    const result = await app.createCaller(ctx).portal.getOnboardingJourney({ venueId: 'venue-1' })

    expect(result.projection.primaryAction.stage).toBe('QUESTIONS')
    expect(result.questions.items).toEqual([
      {
        requestId: 'request-1',
        subject: 'Accessible entrance',
        prompts: ['Which entrance has a step-free route?', 'Is it open every day?'],
        additionalPromptCount: 0,
      },
    ])
    expect(result.qa).toEqual({
      state: 'COMPLETED',
      passed: 4,
      failed: 2,
      operationalIssues: 1,
      safetyCriticalFailed: 2,
      requiredDimensions: 7,
      assessedDimensions: 7,
      exactPackage: true,
    })
    expect(result.materialTypes).toEqual({
      WEBSITE: 0,
      DOCUMENT: 0,
      PHOTO: 2,
      VIDEO_AUDIO: 0,
      FLOOR_PLAN: 0,
      FAQ: 0,
      STAFF_INTERVIEW: 0,
      OTHER: 1,
    })
    expect(evalRunFindFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        packageSnapshotRef: 'venue-package-v1:package-1',
        packageSnapshotHash: 'a'.repeat(64),
        contentSnapshotKind: 'APPROVED_VENUE_PACKAGE_V1',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true },
    })
    expect(evalResultFindMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', venueId: 'venue-1', runId: 'run-1' },
      select: {
        outcome: true,
        passed: true,
        evalCase: { select: { caseKey: true } },
      },
    })
  })

  it('fails nondisclosingly before any journey evidence read for another tenant venue', async () => {
    venueFindFirst.mockResolvedValue(null)
    uploadGroupBy.mockClear()
    supportCount.mockClear()

    await expect(
      app.createCaller(ctx).portal.getOnboardingJourney({ venueId: 'foreign-venue' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(uploadGroupBy).not.toHaveBeenCalled()
    expect(supportCount).not.toHaveBeenCalled()
  })
})
