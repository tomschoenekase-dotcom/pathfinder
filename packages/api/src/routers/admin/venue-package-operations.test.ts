import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  venue: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    venue: { findFirst: mocks.venue },
    venuePackage: { findMany: mocks.list, findFirst: mocks.detail },
  },
  withTenantIsolationBypass: mocks.bypass,
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { canonicalVenuePackagePayload, VenuePackagePayload } from '../../schemas/venue-package'
import { adminVenuePackageOperationsRouter } from './venue-package-operations'

const call = (isPlatformAdmin = true) =>
  router({ admin: adminVenuePackageOperationsRouter }).createCaller({
    db: {} as TRPCContext['db'],
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
  createdAt: new Date('2026-08-11T10:00:00.000Z'),
  updatedAt: new Date('2026-08-11T10:00:00.000Z'),
}

describe('admin venue-package operations reads', () => {
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
