import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), available: vi.fn() }))
vi.mock('@pathfinder/config', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  db: { intakeRun: { findFirst: mocks.findFirst } },
  assertVenueAvailable: mocks.available,
  withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
}))

import { VenuePackagePayloadV1 } from '@pathfinder/contracts'
import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { mediaIntakeHash, validateMediaIntakeSnapshot } from '../../lib/media-intake-snapshot'
import { mediaIngestionHandoffRouter } from './media-ingestion-handoff'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a', runId: 'run-a' }
const testRouter = router({ mediaIngestion: mediaIngestionHandoffRouter })
function caller(isPlatformAdmin = true) {
  return testRouter.createCaller({
    db: {} as never,
    headers: new Headers(),
    session: { userId: 'admin-a', activeTenantId: null, role: null, isPlatformAdmin },
  } as TRPCContext)
}
function snapshot() {
  const draft = VenuePackagePayloadV1.parse({
    schemaVersion: 1,
    places: [],
    knowledgeEntries: [{ title: 'Arrival', category: 'arrival', content: 'Ask at reception.' }],
  })
  const finding = {
    sourceId: 's1',
    filename: 'arrival.jpg',
    mediaType: 'IMAGE',
    summary: '😀'.repeat(24_000),
    uncertainties: ['The route was not observed.'],
  }
  return validateMediaIntakeSnapshot({
    kind: 'MEDIA_PROJECT_REVIEW',
    version: 1,
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    projectId: 'project-a',
    requestId: '65d674b8-2636-42be-8c83-0640248da42a',
    sourceGeneration: '1cbbcc27-aadb-4a4f-bfa7-dced47eaeefe',
    reviewedUpdatedAt: '2026-09-07T07:30:00.000Z',
    reviewedBy: 'admin-a',
    reviewRationale: 'Verified source.',
    draft,
    bindings: [
      {
        kind: 'knowledge',
        itemIndex: 0,
        itemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
        sourceIds: ['s1'],
      },
    ],
    sources: [
      {
        sourceId: 's1',
        assetId: 'asset-a',
        sha256: 'a'.repeat(64),
        filename: 'arrival.jpg',
        mediaType: 'IMAGE',
        analysisHash: mediaIntakeHash(finding),
        finding,
      },
    ],
  })
}

beforeEach(() => vi.clearAllMocks())
describe('media handoff focused source reads', () => {
  it('loads only scoped metadata for the focused Builder link', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'run-a',
      displayName: 'Reviewed arrival',
      status: 'AWAITING_REVIEW',
    })
    expect(await caller().mediaIngestion.getIntakeHandoff(scope)).toMatchObject({
      id: 'run-a',
      structuredBootstrap: { kind: 'MEDIA_PROJECT_REVIEW' },
    })
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'run-a',
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        structuredBootstrap: { path: ['kind'], equals: 'MEDIA_PROJECT_REVIEW' },
      },
      select: { id: true, displayName: true, status: true },
    })
  })

  it('reconstructs complete retained Unicode evidence with bounded pages and a stable hash', async () => {
    const retained = snapshot()
    mocks.findFirst.mockResolvedValue({ structuredBootstrap: retained })
    let offset = 0
    const pages: string[] = []
    for (;;) {
      const page = await caller().mediaIngestion.readIntakeHandoffEvidence({ ...scope, offset })
      expect(page.text.length).toBeLessThanOrEqual(20_000)
      expect(page.snapshotHash).toBe(mediaIntakeHash(retained))
      expect(page.text.charCodeAt(0) >= 0xdc00 && page.text.charCodeAt(0) <= 0xdfff).toBe(false)
      pages.push(page.text)
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
    expect(pages.length).toBeGreaterThan(2)
    expect(JSON.parse(pages.join(''))).toEqual(retained)
    await expect(
      caller().mediaIngestion.readIntakeHandoffEvidence({ ...scope, offset: 50_000_000 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects non-admin reads and unavailable scoped records', async () => {
    await expect(caller(false).mediaIngestion.getIntakeHandoff(scope)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    mocks.findFirst.mockResolvedValue(null)
    await expect(
      caller().mediaIngestion.readIntakeHandoffEvidence({ ...scope, venueId: 'venue-b' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
