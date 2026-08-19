import { beforeEach, describe, expect, it, vi } from 'vitest'

const draftMocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  lockVenueContentMutation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../routers/venue-package', () => ({
  createVenuePackageDraftService: draftMocks.create,
}))

import { reviewVenuePackageManifestService } from './venue-package-manifest-service'

const venueId = 'cm00000000000000000000009'
const fullHash = 'a'.repeat(64)

function provenance() {
  return {
    sourceIds: ['source_review'],
    evidenceIds: [],
    createdAt: '2026-08-12T12:00:00.000Z',
    createdBy: { kind: 'OPERATOR' as const, actorRef: 'admin_1' },
  }
}

function patch(baseManifestHash = fullHash) {
  return {
    schemaVersion: 2 as const,
    packageType: 'PATCH' as const,
    manifestId: '11111111-1111-4111-8111-111111111111',
    venueRef: venueId,
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    baseManifestHash,
    provenance: provenance(),
    operations: [
      {
        operationId: '33333333-3333-4333-8333-333333333333',
        op: 'RESET_CONFIGURATION' as const,
        path: 'branding.accentColor' as const,
      },
    ],
  }
}

function full() {
  return {
    schemaVersion: 2 as const,
    packageType: 'FULL' as const,
    manifestId: '44444444-4444-4444-8444-444444444444',
    venueRef: venueId,
    idempotencyKey: '55555555-5555-4555-8555-555555555555',
    provenance: provenance(),
    identity: {
      venueStableId: venueId,
      name: 'Museum',
      slug: 'museum',
      archetype: 'museum' as const,
    },
    branding: { themeId: 'default' as const, fontId: 'jakarta' as const },
    aiConfiguration: {
      tone: { preset: 'friendly' as const, behaviorVersion: 1 },
      modelReferences: [],
    },
    capabilities: { enabled: [], effectiveConfigurationProvenance: [] },
    contentModules: [],
    assets: [],
    evaluation: {
      evaluationRunId: 'eval_1',
      readinessAssessmentId: 'readiness_1',
      readiness: 'NOT_READY' as const,
    },
  }
}

function harness(options: { base?: boolean; existing?: unknown } = {}) {
  const artifact = {
    findFirst: vi.fn(
      async (args: { where?: { packageType?: string; idempotencyKey?: string } }) => {
        if (args.where?.packageType === 'FULL') return options.base ? { id: 'base_1' } : null
        return options.existing ?? null
      },
    ),
    create: vi.fn(async ({ data }: { data: object }) => ({ id: 'artifact_1', ...data })),
  }
  const tx = {
    venue: { findFirst: vi.fn().mockResolvedValue({ id: venueId, name: 'Museum' }) },
    venuePackage: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          manifestArtifactId: null,
          updatedAt: new Date('2026-08-12T12:00:00Z'),
        }),
      update: vi.fn(async ({ data }) => ({
        id: 'draft_1',
        updatedAt: new Date('2026-08-12T12:01:00Z'),
        ...data,
      })),
    },
    venuePackageManifestArtifact: artifact,
  }
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  }
  return { db, tx, artifact }
}

const actor = { type: 'HUMAN' as const, id: 'admin_1', role: 'PLATFORM_ADMIN' as const }

describe('venue package manifest service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    draftMocks.create.mockImplementation(async ({ finalizer }) => {
      const h = harness({ base: true })
      const attachment = await finalizer({
        tx: h.tx,
        packageId: 'draft_1',
        tenantId: 'tenant_1',
        venueId,
        status: 'DRAFT',
        createdBy: 'admin_1',
        preview: {},
        replayed: false,
      })
      return { value: { id: 'draft_1' }, attachment }
    })
  })

  it('rejects a non-owner human actor before opening a transaction', async () => {
    const h = harness()
    await expect(
      reviewVenuePackageManifestService({
        db: h.db as never,
        tenantId: 'tenant_1',
        venueId,
        actor: { type: 'HUMAN', id: 'manager_1', role: 'MANAGER' } as never,
        manifest: full(),
        persist: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.db.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a blank authorized actor identity before opening a transaction', async () => {
    const h = harness()
    await expect(
      reviewVenuePackageManifestService({
        db: h.db as never,
        tenantId: 'tenant_1',
        venueId,
        actor: { type: 'HUMAN', id: '   ', role: 'OWNER' },
        manifest: full(),
        persist: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.db.$transaction).not.toHaveBeenCalled()
  })

  it('persists FULL evidence but gates all FULL materialization and creates no legacy draft', async () => {
    const h = harness()
    const result = await reviewVenuePackageManifestService({
      db: h.db as never,
      tenantId: 'tenant_1',
      venueId,
      actor,
      manifest: full(),
      persist: true,
    })
    expect(result.materialization.status).toBe('NOT_MATERIALIZABLE')
    expect(Object.values(result.materialization.coverage)).toEqual(Array(7).fill('BLOCKED'))
    expect(result.legacyDraftInput).toBeNull()
    expect(h.artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          packageType: 'FULL',
          materializationStatus: 'NOT_MATERIALIZABLE',
        }),
      }),
    )
  })

  it('requires an exact persisted same-scope FULL base before exposing a PATCH bridge', async () => {
    const missing = harness()
    const rejected = await reviewVenuePackageManifestService({
      db: missing.db as never,
      tenantId: 'tenant_1',
      venueId,
      actor,
      manifest: patch(),
      persist: false,
    })
    expect(rejected.materialization.status).toBe('NOT_MATERIALIZABLE')
    expect(rejected.materialization.issues).toContainEqual(
      expect.objectContaining({ code: 'FULL_BASE_NOT_FOUND' }),
    )
    expect(rejected.legacyDraftInput).toBeNull()

    const exact = harness({ base: true })
    const accepted = await reviewVenuePackageManifestService({
      db: exact.db as never,
      tenantId: 'tenant_1',
      venueId,
      actor,
      manifest: patch(),
      persist: false,
    })
    expect(accepted.materialization.status).toBe('MATERIALIZABLE')
    expect(accepted.materialization.issues.map((issue) => issue.code)).not.toEqual(
      expect.arrayContaining([
        'BASE_HASH_DELEGATED',
        'EVIDENCE_METADATA_NOT_PERSISTED',
        'MODULE_EVIDENCE_NOT_PERSISTED',
      ]),
    )
    expect(accepted.materialization.legacyPayloadHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(accepted.legacyDraftInput).toMatchObject({ venueId, payload: { schemaVersion: 3 } })
  })

  it('returns the post-link package revision for immediate optimistic-concurrency approval', async () => {
    const h = harness({ base: true })
    const result = await reviewVenuePackageManifestService({
      db: h.db as never,
      tenantId: 'tenant_1',
      venueId,
      actor,
      manifest: patch(),
      persist: true,
    })

    expect(result.draft).toMatchObject({
      id: 'draft_1',
      updatedAt: new Date('2026-08-12T12:01:00Z'),
    })
  })

  it('keeps unsupported PATCH operations gated even with an exact base', async () => {
    const unsupported = patch()
    unsupported.operations = [
      {
        operationId: '66666666-6666-4666-8666-666666666666',
        op: 'UPSERT_ASSET',
        value: {
          assetId: 'asset_hero',
          sha256: 'b'.repeat(64),
          mediaType: 'image/png',
          byteSize: 123,
          immutableRef: `asset:sha256/${'b'.repeat(64)}`,
        },
      },
    ] as never
    const h = harness({ base: true })
    const result = await reviewVenuePackageManifestService({
      db: h.db as never,
      tenantId: 'tenant_1',
      venueId,
      actor,
      manifest: unsupported,
      persist: false,
    })
    expect(result.materialization.status).toBe('NOT_MATERIALIZABLE')
    expect(result.materialization.coverage.ASSETS).toBe('BLOCKED')
    expect(result.legacyDraftInput).toBeNull()
    expect(h.artifact.create).not.toHaveBeenCalled()
  })

  it('replays only the same actor and manifest hash', async () => {
    const existing = {
      id: 'artifact_1',
      manifestHash: 'different',
      createdBy: 'admin_1',
    }
    const h = harness({ base: true, existing })
    draftMocks.create.mockImplementationOnce(async ({ finalizer }) => {
      await finalizer({
        tx: h.tx,
        packageId: 'draft_1',
        tenantId: 'tenant_1',
        venueId,
        status: 'DRAFT',
        createdBy: 'admin_1',
        preview: {},
        replayed: true,
      })
    })
    await expect(
      reviewVenuePackageManifestService({
        db: h.db as never,
        tenantId: 'tenant_1',
        venueId,
        actor,
        manifest: patch(),
        persist: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.artifact.create).not.toHaveBeenCalled()
  })

  it('retries transaction conflicts and unique convergence in fresh draft transactions', async () => {
    const transient = Object.assign(new Error('retry'), { code: 'P2034' })
    const unique = Object.assign(new Error('converge'), { code: 'P2002' })
    draftMocks.create.mockRejectedValueOnce(transient).mockRejectedValueOnce(unique)
    const h = harness({ base: true })
    const result = await reviewVenuePackageManifestService({
      db: h.db as never,
      tenantId: 'tenant_1',
      venueId,
      actor,
      manifest: patch(),
      persist: true,
    })
    expect(result).toMatchObject({ artifact: { id: 'artifact_1' }, draft: { id: 'draft_1' } })
    expect(draftMocks.create).toHaveBeenCalledTimes(3)
  })

  it('converges a non-materializable artifact P2002 in a fresh read transaction', async () => {
    const h = harness()
    const manifest = full()
    const converged = {
      id: 'artifact_converged',
      manifestHash: 'placeholder',
      createdBy: actor.id,
    }
    h.artifact.findFirst.mockResolvedValueOnce(null).mockImplementation(async () => converged)
    h.artifact.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    const first = await reviewVenuePackageManifestService({
      db: h.db as never,
      tenantId: 'tenant_1',
      venueId,
      actor,
      manifest,
      persist: false,
    })
    converged.manifestHash = first.manifestHash
    const result = await reviewVenuePackageManifestService({
      db: h.db as never,
      tenantId: 'tenant_1',
      venueId,
      actor,
      manifest,
      persist: true,
    })
    expect(result).toMatchObject({ artifact: { id: 'artifact_converged' }, replayed: true })
    expect(h.db.$transaction).toHaveBeenCalledTimes(4)
  })
})
