import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  venue: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  db: { venue: { findFirst: mocks.venue } },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminDeploymentManifestReviewRouter } from './deployment-manifest-review'

const call = (admin = true) =>
  router({ admin: adminDeploymentManifestReviewRouter }).createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'operator', activeTenantId: null, role: 'STAFF', isPlatformAdmin: admin },
  })
const venueId = 'cm00000000000000000000009'
const manifest = {
  schemaVersion: 2,
  packageType: 'PATCH',
  manifestId: '00000000-0000-4000-8000-000000000001',
  venueRef: venueId,
  idempotencyKey: '00000000-0000-4000-8000-000000000002',
  baseManifestHash: 'a'.repeat(64),
  provenance: {
    sourceIds: ['source_interview'],
    evidenceIds: [],
    createdAt: '2026-08-11T20:00:00.000Z',
    createdBy: { kind: 'OPERATOR', actorRef: 'user_1' },
  },
  operations: [
    {
      operationId: '00000000-0000-4000-8000-000000000011',
      op: 'UPSERT_IDENTITY',
      value: { venueStableId: 'venue', name: 'Museum', slug: 'museum', archetype: 'museum' },
    },
  ],
}

describe('deployment manifest review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venue.mockResolvedValue({ id: venueId, name: 'Museum' })
  })
  it('rejects non-admin access before the bypass', async () => {
    await expect(
      call(false).admin.reviewDeploymentManifest({ tenantId: 't1', venueId, manifestJson: '{}' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })
  it('requires the venue in the exact tenant scope', async () => {
    mocks.venue.mockResolvedValue(null)
    await expect(
      call().admin.reviewDeploymentManifest({ tenantId: 't1', venueId, manifestJson: '{}' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.venue).toHaveBeenCalledWith({
      where: { id: venueId, tenantId: 't1' },
      select: { id: true, name: true },
    })
  })
  it('returns exact preview/draft handoff shapes without persistence', async () => {
    const result = await call().admin.reviewDeploymentManifest({
      tenantId: 't1',
      venueId,
      manifestJson: JSON.stringify(manifest),
    })
    expect(result.compatible).toBe(true)
    expect(result.previewInput).toMatchObject({ venueId, payload: { schemaVersion: 3 } })
    expect(result.draftInput).toMatchObject({
      venueId,
      draftKey: manifest.idempotencyKey,
      payload: { schemaVersion: 3 },
    })
    expect(result.handoff).toMatchObject({
      previewProcedure: 'venuePackage.preview',
      draftProcedure: 'venuePackage.createDraft',
    })
  })
  it('does not echo rejected secret-bearing input', async () => {
    const secret = 'do-not-reflect-this-secret'
    const result = await call().admin.reviewDeploymentManifest({
      tenantId: 't1',
      venueId,
      manifestJson: JSON.stringify({ ...manifest, secret }),
    })
    expect(result.compatible).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.previewInput).toBeNull()
    expect(result.draftInput).toBeNull()
  })
})
