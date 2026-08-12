import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  venue: vi.fn(),
  artifact: vi.fn(),
  artifactCreate: vi.fn(),
  draftCreate: vi.fn(),
}))
vi.mock('../../routers/venue-package', () => ({
  createVenuePackageDraftService: mocks.draftCreate,
}))
vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  lockVenueContentMutation: vi.fn().mockResolvedValue(undefined),
  db: {
    $transaction: (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        venue: { findFirst: mocks.venue },
        venuePackageManifestArtifact: {
          findFirst: mocks.artifact,
          create: mocks.artifactCreate,
        },
      }),
    venue: { findFirst: mocks.venue },
  },
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
const fullEnvelope = {
  tenantId: 't1',
  venueId,
  manifestId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
}
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
    mocks.artifact.mockImplementation(async ({ where }) =>
      where.packageType === 'FULL' ? { id: 'base_1' } : null,
    )
    mocks.artifactCreate.mockImplementation(async ({ data }) => ({ id: 'artifact_1', ...data }))
    mocks.draftCreate.mockImplementation(async ({ finalizer }) => {
      const tx = {
        venuePackageManifestArtifact: {
          findFirst: mocks.artifact,
          create: mocks.artifactCreate,
        },
        venuePackage: {
          findFirst: vi.fn().mockResolvedValue({ manifestArtifactId: null }),
          update: vi.fn().mockResolvedValue({ id: 'draft_1' }),
        },
      }
      const attachment = await finalizer({ tx, packageId: 'draft_1', replayed: false })
      return { value: { id: 'draft_1' }, attachment }
    })
  })
  it('rejects non-admin access before the bypass', async () => {
    await expect(
      call(false).admin.reviewDeploymentManifest({ tenantId: 't1', venueId, manifestJson: '{}' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })
  it('rejects non-admin artifact persistence before bypass or writes', async () => {
    await expect(
      call(false).admin.createVenuePackageManifestArtifact({
        tenantId: 't1',
        venueId,
        manifestJson: JSON.stringify(manifest),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.artifactCreate).not.toHaveBeenCalled()
  })
  it('persists canonical evidence with its supported compatibility DRAFT', async () => {
    const result = await call().admin.createVenuePackageManifestArtifact({
      tenantId: 't1',
      venueId,
      manifestJson: JSON.stringify(manifest),
    })
    expect(result).toMatchObject({
      artifactKind: 'VENUE_DEPLOYMENT_MANIFEST_V2',
      materialization: { status: 'MATERIALIZABLE' },
      artifact: { id: 'artifact_1', createdBy: 'operator' },
      draft: { id: 'draft_1' },
      replayed: false,
    })
    expect(mocks.artifactCreate).toHaveBeenCalledTimes(1)
  })
  it('requires the venue in the exact tenant scope', async () => {
    mocks.venue.mockResolvedValue(null)
    await expect(
      call().admin.reviewDeploymentManifest({
        tenantId: 't1',
        venueId,
        manifestJson: JSON.stringify(manifest),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.venue).toHaveBeenCalledWith({
      where: { id: venueId, tenantId: 't1' },
      select: { id: true, name: true },
    })
  })
  it('returns exact base-bound preview/draft handoff shapes without persistence', async () => {
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
    expect(result.materialization).toMatchObject({ status: 'MATERIALIZABLE' })
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

  it('requires platform admin authorization before FULL projection access', async () => {
    await expect(
      call(false).admin.previewFullVenueDeploymentManifest(fullEnvelope),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.venue).not.toHaveBeenCalled()
  })

  it('returns a validated canonical FULL preview without persistence or apply handoff', async () => {
    mocks.venue.mockResolvedValue({
      id: venueId,
      name: 'Museum',
      slug: 'museum',
      description: 'Public description',
      category: 'museum',
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      aiTone: 'FRIENDLY',
      aiGuideName: 'Ari',
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      isActive: true,
      updatedAt: new Date('2026-08-11T20:00:00.000Z'),
    })

    const result = await call().admin.previewFullVenueDeploymentManifest(fullEnvelope)

    expect(result.manifest).toMatchObject({
      packageType: 'FULL',
      manifestId: fullEnvelope.manifestId,
      idempotencyKey: fullEnvelope.idempotencyKey,
      venueRef: venueId,
      contentModules: [],
      assets: [],
      evaluation: { readiness: 'NOT_READY' },
    })
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.readiness).toMatchObject({ status: 'NOT_READY', readyForApply: false })
    expect(result).not.toHaveProperty('draftInput')
    expect(result).not.toHaveProperty('applyInput')
    expect(mocks.venue).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: venueId, tenantId: 't1' } }),
    )
  })

  it('rejects malformed FULL envelope input before bypass or database access', async () => {
    await expect(
      call().admin.previewFullVenueDeploymentManifest({
        ...fullEnvelope,
        idempotencyKey: 'not-a-uuid',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.venue).not.toHaveBeenCalled()
  })
})
