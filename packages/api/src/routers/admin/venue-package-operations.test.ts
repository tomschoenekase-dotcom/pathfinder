import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  venue: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  orchestrate: vi.fn(),
  approve: vi.fn(),
  apply: vi.fn(),
  revert: vi.fn(),
  evaluationRuns: vi.fn(),
  evaluationOutcomes: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    venue: { findFirst: mocks.venue },
    venuePackage: { findMany: mocks.list, findFirst: mocks.detail },
    evalRun: { findMany: mocks.evaluationRuns },
    evalResult: { groupBy: mocks.evaluationOutcomes },
  },
  setContentVersionContext: vi.fn(async () => undefined),
  withTenantIsolationBypass: mocks.bypass,
}))

vi.mock('../venue-package', () => ({
  createVenuePackageDraftService: mocks.orchestrate,
}))

vi.mock('../../lib/venue-package-core', () => ({
  approveVenuePackageLifecycle: mocks.approve,
  applyVenuePackageLifecycle: mocks.apply,
  revertVenuePackageLifecycle: mocks.revert,
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { canonicalVenuePackagePayload, VenuePackagePayload } from '../../schemas/venue-package'
import { adminVenuePackageOperationsRouter } from './venue-package-operations'

const call = (isPlatformAdmin = true) =>
  router({ admin: adminVenuePackageOperationsRouter }).createCaller({
    db: {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
    } as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'operator-1', activeTenantId: null, role: 'STAFF', isPlatformAdmin },
  })

const report = {
  errors: [],
  warnings: [],
  semanticDuplicateScan: {
    status: 'COMPLETE',
    similarityThreshold: 0.9,
    scopes: {
      places: {
        embeddingProfile: 'openai:text-embedding-3-small:1536',
        inputCount: 1,
        scannedInputCount: 1,
        existingCount: 2,
        scannedExistingCount: 2,
      },
      knowledgeEntries: {
        embeddingProfile: 'openai:text-embedding-3-small:1536',
        inputCount: 1,
        scannedInputCount: 1,
        existingCount: 3,
        scannedExistingCount: 3,
      },
    },
  },
}

const summary = {
  id: 'package-1',
  schemaVersion: 1,
  payloadHash: 'a'.repeat(64),
  baseDigest: 'b'.repeat(64),
  validationReport: report,
  status: 'DRAFT',
  approvedAt: null,
  appliedAt: null,
  revertedAt: null,
  supportHandoffs: [],
  createdAt: new Date('2026-08-11T10:00:00.000Z'),
  updatedAt: new Date('2026-08-11T10:00:00.000Z'),
}

describe('admin venue-package operations reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.evaluationRuns.mockResolvedValue([])
    mocks.evaluationOutcomes.mockResolvedValue([])
  })

  it('keeps lifecycle services stateless and free of fabricated resolver contexts', () => {
    const source = readFileSync(new URL('../../lib/venue-package-core.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/let\s+(apply|revert)VenuePackageResolver/)
    expect(source).not.toContain('lifecycleResolverContext')
    expect(source).not.toContain('configureVenuePackageLifecycleService')
    expect(source).not.toMatch(/session:\s*\{[\s\S]{0,200}activeTenantId/)
  })

  it('keeps reviewed-draft adapters free of router call-through and hidden finalizer state', () => {
    const adapterSources = [
      './venue-package-operations.ts',
      './support-reviewed-drafts.ts',
      './intake-operations.ts',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    const finalizerSource = readFileSync(
      new URL('../../lib/venue-package-draft-finalizer.ts', import.meta.url),
      'utf8',
    )

    for (const source of adapterSources) {
      expect(source).not.toContain('createCaller')
      expect(source).not.toContain('activeTenantId')
      expect(source).not.toMatch(/role:\s*['"]MANAGER['"]/)
      expect(source).not.toContain('admin-reviewed-draft-orchestration')
    }
    expect(finalizerSource).not.toContain('AsyncLocalStorage')
    expect(finalizerSource).not.toContain('withVenuePackageDraftFinalizer')
    expect(finalizerSource).not.toContain('runVenuePackageDraftFinalizer')
    expect(
      existsSync(new URL('../../lib/admin-reviewed-draft-orchestration.ts', import.meta.url)),
    ).toBe(false)
  })

  it.each([
    ['approveVenuePackage', mocks.approve, true],
    ['applyVenuePackage', mocks.apply, false],
    ['revertVenuePackage', mocks.revert, false],
  ] as const)(
    '%s is an authenticated exact-scope PLATFORM_ADMIN adapter',
    async (procedure, action, approval) => {
      action.mockResolvedValue({
        id: 'package-1',
        status: 'APPROVED',
        updatedAt: summary.updatedAt,
      })
      const input = {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        id: 'package-1',
        expectedUpdatedAt: summary.updatedAt,
        commandKey: '11111111-1111-4111-8111-111111111111',
        ...(approval
          ? {
              acknowledgedWarningDigest: 'a'.repeat(64),
              acknowledgedPayloadHash: 'b'.repeat(64),
            }
          : {}),
      }
      await (call().admin[procedure] as (value: typeof input) => Promise<unknown>)(input)
      expect(action).toHaveBeenCalledWith({
        db: expect.anything(),
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
        command: expect.objectContaining(input),
      })
      action.mockClear()
      await expect(
        (call(false).admin[procedure] as (value: typeof input) => Promise<unknown>)(input),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(action).not.toHaveBeenCalled()
    },
  )

  it('adapts reviewed DRAFT creation through server-owned platform-admin orchestration', async () => {
    mocks.orchestrate.mockResolvedValue({ value: { id: 'package-1' }, attachment: {} })
    const payload = {
      schemaVersion: 1 as const,
      places: [],
      knowledgeEntries: [
        { title: 'Hours', category: 'FAQ', content: 'Check current hours.', isEnabled: true },
      ],
    }
    await call().admin.createReviewedVenuePackageDraft({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      draftKey: '11111111-1111-4111-8111-111111111111',
      payload,
    })
    expect(mocks.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        input: expect.objectContaining({ venueId: 'venue-1', payload }),
        actor: { type: 'HUMAN', id: 'operator-1', role: 'PLATFORM_ADMIN' },
        db: expect.anything(),
        finalizer: expect.any(Function),
      }),
    )
    mocks.orchestrate.mockClear()
    await expect(
      call(false).admin.createReviewedVenuePackageDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        draftKey: '11111111-1111-4111-8111-111111111111',
        payload,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.orchestrate).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venue.mockResolvedValue({ id: 'venue-1' })
    mocks.list.mockResolvedValue([])
  })

  it('authenticates before any tenant bypass or read', async () => {
    await expect(
      call(false).admin.listVenuePackagesForReview({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('proves the exact venue scope and uses a bounded stable cursor safe-select', async () => {
    mocks.list.mockResolvedValue([summary, { ...summary, id: 'package-0' }])
    const result = await call().admin.listVenuePackagesForReview({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      limit: 1,
      cursorAt: '2026-08-12T00:00:00.000Z',
      cursorId: 'package-2',
    })
    expect(mocks.venue).toHaveBeenCalledWith({
      where: { id: 'venue-1', tenantId: 'tenant-1' },
      select: { id: true },
    })
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    )
    expect(result.items[0]).toMatchObject({ errorCount: 0, warningCount: 0 })
    expect(result.items[0]).not.toHaveProperty('payload')
    expect(result.items[0]).not.toHaveProperty('validationReport')
    expect(result.nextCursor).toEqual({
      createdAt: '2026-08-11T10:00:00.000Z',
      id: 'package-1',
    })
  })

  it('rejects detail when stored review evidence is inconsistent', async () => {
    mocks.detail.mockResolvedValue({
      ...summary,
      payload: { schemaVersion: 1, places: [], knowledgeEntries: [] },
      previewPlan: { invalid: true },
    })
    await expect(
      call().admin.getVenuePackageForReview({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        packageId: 'package-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('returns only a schema-valid payload bound to the stored venue hash', async () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [
        {
          title: 'Visitor information',
          category: 'FAQ',
          content: 'Ask the front desk for current visitor information.',
          isEnabled: true,
        },
      ],
    })
    const payloadHash = createHash('sha256')
      .update(canonicalVenuePackagePayload('venue-1', payload))
      .digest('hex')
    const warningDigest = createHash('sha256').update(JSON.stringify(report.warnings)).digest('hex')
    mocks.detail.mockResolvedValue({
      ...summary,
      payloadHash,
      payload,
      previewPlan: {
        schemaVersion: 1,
        payloadHash,
        baseDigest: summary.baseDigest,
        warningDigest,
        mode: 'ADDITIVE_V1',
        report,
        changes: {
          places: { add: [], change: [], remove: [], unchanged: 0 },
          knowledgeEntries: {
            add: payload.knowledgeEntries,
            change: [],
            remove: [],
            unchanged: 0,
          },
        },
      },
    })

    const result = await call().admin.getVenuePackageForReview({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      packageId: 'package-1',
    })

    expect(result.payload).toEqual(payload)
    expect(mocks.detail).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'package-1', tenantId: 'tenant-1', venueId: 'venue-1' },
      }),
    )
  })

  it.each([
    ['schema version', { schemaVersion: 2 }],
    ['warning digest', { warningDigest: 'd'.repeat(64) }],
  ])('rejects a stored preview with mismatched %s evidence', async (_label, previewPatch) => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [
        { title: 'Hours', category: 'FAQ', content: 'Check current hours.', isEnabled: true },
      ],
    })
    const payloadHash = createHash('sha256')
      .update(canonicalVenuePackagePayload('venue-1', payload))
      .digest('hex')
    const warningDigest = createHash('sha256').update(JSON.stringify(report.warnings)).digest('hex')
    mocks.detail.mockResolvedValue({
      ...summary,
      payloadHash,
      payload,
      previewPlan: {
        schemaVersion: 1,
        payloadHash,
        baseDigest: summary.baseDigest,
        warningDigest,
        mode: 'ADDITIVE_V1',
        report,
        changes: {
          places: { add: [], change: [], remove: [], unchanged: 0 },
          knowledgeEntries: {
            add: payload.knowledgeEntries,
            change: [],
            remove: [],
            unchanged: 0,
          },
        },
        ...previewPatch,
      },
    })

    await expect(
      call().admin.getVenuePackageForReview({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        packageId: 'package-1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
