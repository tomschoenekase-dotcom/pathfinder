import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../context'
import { router } from '../core'

const { buildPreview, assertCurrent, parseStored, createFeedback, createSupport } = vi.hoisted(
  () => ({
    buildPreview: vi.fn(),
    assertCurrent: vi.fn(),
    parseStored: vi.fn(),
    createFeedback: vi.fn(),
    createSupport: vi.fn(),
  }),
)

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  createPreviewFeedbackRequestAction: createFeedback,
  createSupportRequestAction: createSupport,
}))

vi.mock('./venue-package', () => ({
  venuePackageRouter: router({}),
  buildVenuePackagePreview: buildPreview,
  assertStoredVenuePackageEvidenceCurrent: assertCurrent,
  parseStoredVenuePackagePreview: parseStored,
  VenuePackageApprovedBaseStaleError: class VenuePackageApprovedBaseStaleError extends TRPCError {
    constructor() {
      super({ code: 'CONFLICT', message: 'Venue content changed; create a new preview' })
    }
  },
}))

import { clientPreviewLifecycleFailureState, portalRouter } from './portal'
import { VenuePackageApprovedBaseStaleError } from './venue-package'

const packageFindFirst = vi.fn()
const venueFindFirst = vi.fn()
const approvedAt = new Date('2030-01-01T00:00:00.000Z')
const stored = {
  schemaVersion: 1 as const,
  payloadHash: 'a'.repeat(64),
  baseDigest: 'b'.repeat(64),
  warningDigest: 'c'.repeat(64),
  mode: 'ADDITIVE_V1' as const,
  report: {
    errors: [],
    warnings: [],
    semanticDuplicateScan: {
      status: 'COMPLETE' as const,
      similarityThreshold: 0.9,
      scopes: {
        places: {
          embeddingProfile: 'test',
          inputCount: 1,
          scannedInputCount: 1,
          existingCount: 0,
          scannedExistingCount: 0,
        },
        knowledgeEntries: {
          embeddingProfile: 'test',
          inputCount: 0,
          scannedInputCount: 0,
          existingCount: 0,
          scannedExistingCount: 0,
        },
      },
    },
  },
  changes: {
    places: {
      add: [{ name: 'Gallery', type: 'room', tags: [], importanceScore: 1 }],
      change: [],
      remove: [],
      unchanged: 0,
    },
    knowledgeEntries: { add: [], change: [], remove: [], unchanged: 0 },
  },
}

const db = {
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  venuePackage: { findFirst: packageFindFirst },
  venue: { findFirst: venueFindFirst },
} as unknown as TRPCContext['db']

function context(role: 'STAFF' | 'MANAGER' | 'OWNER' = 'STAFF'): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId: 'user_1', activeTenantId: 'tenant_1', role, isPlatformAdmin: false },
  }
}

const app = router({ portal: portalRouter })

describe('package-bound client preview read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    packageFindFirst.mockResolvedValue({
      id: 'package_1',
      venueId: 'venue_1',
      schemaVersion: 1,
      payload: {
        schemaVersion: 1,
        places: [{ name: 'Gallery', type: 'room' }],
        knowledgeEntries: [],
      },
      payloadHash: stored.payloadHash,
      baseDigest: stored.baseDigest,
      validationReport: stored.report,
      previewPlan: stored,
      approvedAt,
      approvedBy: 'owner_1',
      approvedCommandKey: '00000000-0000-4000-8000-000000000001',
      approvalWarningDigest: stored.warningDigest,
      approvedWarningCodes: [],
    })
    venueFindFirst.mockResolvedValue({
      id: 'venue_1',
      name: 'Museum',
      description: null,
      category: null,
      chatTheme: null,
      chatAccentColor: null,
      chatFont: null,
      chatLogoUrl: null,
      chatBannerUrl: null,
      aiGuideName: null,
      aiTone: null,
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      places: [],
      knowledgeEntries: [],
    })
    parseStored.mockReturnValue(stored)
    buildPreview.mockResolvedValue(stored)
  })

  it('classifies only exact base staleness as superseded and rethrows infrastructure errors', () => {
    expect(clientPreviewLifecycleFailureState(new VenuePackageApprovedBaseStaleError())).toBe(
      'SUPERSEDED',
    )
    expect(
      clientPreviewLifecycleFailureState(
        new TRPCError({ code: 'PRECONDITION_FAILED', message: 'corrupt evidence' }),
      ),
    ).toBe('UNAVAILABLE')
    const infrastructureError = new Error('database unavailable')
    expect(() => clientPreviewLifecycleFailureState(infrastructureError)).toThrow(
      infrastructureError,
    )
  })

  it('allows STAFF but exact-scopes an APPROVED package and returns no review internals', async () => {
    const result = await app.createCaller(context()).portal.getClientPreview({
      venueId: 'venue_1',
      packageId: 'package_1',
    })
    expect(packageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'package_1', tenantId: 'tenant_1', venueId: 'venue_1', status: 'APPROVED' },
      }),
    )
    expect(assertCurrent).toHaveBeenCalledOnce()
    expect(db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    })
    expect(result).toMatchObject({ package: { status: 'APPROVED' }, guestAccessible: false })
    expect(JSON.stringify(result)).not.toMatch(/payloadHash|baseDigest|report|warning|approvedBy/iu)
  })

  it('creates feedback with authoritative session scope and no caller-authored metadata', async () => {
    createFeedback.mockImplementationOnce(async (input, options) => {
      await options.assertEligible(db, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        packageId: input.packageId,
      })
      return {
        request: {
          id: 'request_1',
          venueId: 'venue_1',
          category: 'EXPERIENCE_BEHAVIOR',
          status: 'OPEN',
          subject: 'Feedback on approved preview',
          missingInformation: [],
          version: 9,
          clientVersion: 1,
          clientActivityAt: approvedAt,
          statusChangedAt: approvedAt,
          createdAt: approvedAt,
          updatedAt: approvedAt,
        },
        message: {
          id: 'message_1',
          authorKind: 'CLIENT',
          visibility: 'CLIENT_VISIBLE',
          body: 'feedback',
          createdAt: approvedAt,
          attachments: [
            {
              id: 'attachment_1',
              filename: 'safe.pdf',
              mediaType: 'application/pdf',
              byteSize: 42n,
              createdAt: approvedAt,
            },
          ],
        },
        feedback: { packageId: 'package_1', createdAt: approvedAt },
        replayed: false,
      }
    })
    const result = await app.createCaller(context()).portal.createPreviewFeedbackRequest({
      operationId: '00000000-0000-4000-8000-000000000002',
      venueId: 'venue_1',
      packageId: 'package_1',
      body: 'Please clarify the welcome text',
      attachments: [],
    })
    expect(createFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        actor: expect.objectContaining({ actorId: 'user_1', participantKind: 'CLIENT' }),
      }),
      expect.objectContaining({ assertEligible: expect.any(Function) }),
      db,
    )
    expect(result.message.attachments[0]?.byteSize).toBe('42')
    expect(result.request).toMatchObject({
      clientVersion: 1,
      requesterIsCurrentUser: true,
      participantIsCurrentUser: false,
      canReply: true,
    })
    expect(result.request).not.toHaveProperty('version')
    expect(result.request).not.toHaveProperty('updatedAt')
    expect(result.request).not.toHaveProperty('requesterUserId')
    expect(result.request).not.toHaveProperty('createdById')
    expect(result.request).not.toHaveProperty('participants')
  })

  it('rejects raw caller-authored attachment metadata', async () => {
    await expect(
      app.createCaller(context()).portal.createPreviewFeedbackRequest({
        operationId: '00000000-0000-4000-8000-000000000002',
        venueId: 'venue_1',
        packageId: 'package_1',
        body: 'feedback',
        attachments: [{ intakeUploadId: 'upload_1', filename: 'spoof.pdf' }],
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(createFeedback).not.toHaveBeenCalled()
  })

  it('creates a source-version-bound correction with authoritative client identity', async () => {
    createSupport.mockResolvedValueOnce({
      request: {
        id: 'request_correction',
        venueId: 'venue_1',
        category: 'CONTENT_CORRECTION',
        status: 'OPEN',
        subject: 'Correction to onboarding source',
        missingInformation: [],
        version: 1,
        clientVersion: 1,
        clientActivityAt: approvedAt,
        statusChangedAt: approvedAt,
        createdAt: approvedAt,
        updatedAt: approvedAt,
      },
      message: {
        id: 'message_correction',
        authorKind: 'CLIENT',
        visibility: 'CLIENT_VISIBLE',
        body: 'The Saturday hours are wrong.',
        createdAt: approvedAt,
        attachments: [],
      },
      replayed: false,
    })

    const result = await app.createCaller(context()).portal.createIntakeCorrectionRequest({
      operationId: '00000000-0000-4000-8000-000000000003',
      venueId: 'venue_1',
      runId: 'run_1',
      expectedEventCount: 2,
      body: 'The Saturday hours are wrong.',
    })

    expect(createSupport).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        category: 'CONTENT_CORRECTION',
        intakeSource: { runId: 'run_1', expectedEventCount: 2 },
        actor: expect.objectContaining({ actorId: 'user_1', participantKind: 'CLIENT' }),
      }),
      db,
    )
    expect(result.source).toEqual({ runId: 'run_1', expectedEventCount: 2 })
    expect(result.request).not.toHaveProperty('version')
    expect(result.request).not.toHaveProperty('updatedAt')
  })

  it('fails closed when current venue state no longer matches the approved base', async () => {
    assertCurrent.mockImplementationOnce(() => {
      throw new VenuePackageApprovedBaseStaleError()
    })
    await expect(
      app.createCaller(context()).portal.getClientPreview({
        venueId: 'venue_1',
        packageId: 'package_1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('accepts the exact canonical unique warning-code set independent of report order', async () => {
    const warnings = [
      { code: 'B_WARNING', path: 'venue.name', message: 'b' },
      { code: 'A_WARNING', path: 'venue.name', message: 'a' },
      { code: 'B_WARNING', path: 'venue.description', message: 'duplicate code' },
    ]
    const warned = { ...stored, report: { ...stored.report, warnings } }
    parseStored.mockReturnValueOnce(warned)
    buildPreview.mockResolvedValueOnce(warned)
    packageFindFirst.mockResolvedValueOnce({
      id: 'package_1',
      venueId: 'venue_1',
      schemaVersion: 1,
      payload: {
        schemaVersion: 1,
        places: [{ name: 'Gallery', type: 'room' }],
        knowledgeEntries: [],
      },
      payloadHash: stored.payloadHash,
      baseDigest: stored.baseDigest,
      validationReport: warned.report,
      previewPlan: warned,
      approvedAt,
      approvedBy: 'owner_1',
      approvedCommandKey: '00000000-0000-4000-8000-000000000001',
      approvalWarningDigest: stored.warningDigest,
      approvedWarningCodes: ['B_WARNING', 'A_WARNING'],
    })
    await expect(
      app.createCaller(context()).portal.getClientPreview({
        venueId: 'venue_1',
        packageId: 'package_1',
      }),
    ).resolves.toMatchObject({ package: { id: 'package_1' } })
  })

  it('fails closed on incomplete approval and safe-bound evidence defects', async () => {
    packageFindFirst.mockResolvedValueOnce({
      id: 'package_1',
      venueId: 'venue_1',
      schemaVersion: 1,
      payload: { schemaVersion: 1, places: [], knowledgeEntries: [] },
      payloadHash: stored.payloadHash,
      baseDigest: stored.baseDigest,
      validationReport: stored.report,
      previewPlan: stored,
      approvedAt,
      approvedBy: null,
      approvedCommandKey: null,
      approvalWarningDigest: null,
      approvedWarningCodes: ['UNSTORED'],
    })
    await expect(
      app.createCaller(context()).portal.getClientPreview({
        venueId: 'venue_1',
        packageId: 'package_1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    venueFindFirst.mockResolvedValueOnce({
      id: 'venue_1',
      name: 'Museum',
      description: null,
      category: null,
      chatTheme: null,
      chatAccentColor: null,
      chatFont: null,
      chatLogoUrl: null,
      chatBannerUrl: null,
      aiGuideName: null,
      places: Array.from({ length: 501 }, (_, index) => ({ id: `p${index}` })),
      knowledgeEntries: [],
    })
    await expect(
      app.createCaller(context()).portal.getClientPreview({
        venueId: 'venue_1',
        packageId: 'package_1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('fails closed on warning-code mismatch and incomplete semantic evidence', async () => {
    packageFindFirst.mockResolvedValueOnce({
      id: 'package_1',
      venueId: 'venue_1',
      schemaVersion: 1,
      payload: { schemaVersion: 1, places: [], knowledgeEntries: [] },
      payloadHash: stored.payloadHash,
      baseDigest: stored.baseDigest,
      validationReport: stored.report,
      previewPlan: stored,
      approvedAt,
      approvedBy: 'owner_1',
      approvedCommandKey: '00000000-0000-4000-8000-000000000001',
      approvalWarningDigest: stored.warningDigest,
      approvedWarningCodes: ['UNSTORED'],
    })
    await expect(
      app.createCaller(context()).portal.getClientPreview({
        venueId: 'venue_1',
        packageId: 'package_1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    parseStored.mockReturnValueOnce({
      ...stored,
      report: {
        ...stored.report,
        semanticDuplicateScan: { ...stored.report.semanticDuplicateScan, status: 'NOT_RUN' },
      },
    })
    await expect(
      app.createCaller(context()).portal.getClientPreview({
        venueId: 'venue_1',
        packageId: 'package_1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('returns nondisclosing NOT_FOUND for a wrong scope or non-approved package', async () => {
    packageFindFirst.mockResolvedValueOnce(null)
    await expect(
      app.createCaller(context()).portal.getClientPreview({
        venueId: 'venue_other',
        packageId: 'package_1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Approved client preview not found' })
    expect(venueFindFirst).not.toHaveBeenCalled()
  })
})
