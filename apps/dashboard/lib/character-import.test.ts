import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  venue: vi.fn(),
  character: vi.fn(),
  job: vi.fn(),
  brief: vi.fn(),
  prepare: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  submit: vi.fn(),
  put: vi.fn(),
  getVerified: vi.fn(),
  readBundle: vi.fn(),
  resolveRig: vi.fn(),
}))
const ActionError = vi.hoisted(
  () =>
    class extends Error {
      constructor(
        readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
        message: string,
      ) {
        super(message)
      }
    },
)

vi.mock('@pathfinder/db', () => {
  return {
    CustomCharacterFactoryActionError: ActionError,
    db: {
      venue: { findFirst: mocks.venue },
      characterFactoryJob: { findFirst: mocks.job },
      characterCandidateReviewBrief: { findFirst: mocks.brief },
    },
    withTenantIsolationBypass: (fn: () => unknown) => fn(),
    readCustomCharacterFactoryAction: mocks.character,
    prepareCharacterFactoryJobAction: mocks.prepare,
    claimCharacterFactoryJobAction: mocks.claim,
    completeCharacterFactoryJobAction: mocks.complete,
    submitCharacterCandidateReviewBrief: mocks.submit,
  }
})

vi.mock('@pathfinder/character-factory', async () => {
  const actual = await vi.importActual<typeof import('@pathfinder/character-factory')>(
    '@pathfinder/character-factory',
  )
  return { ...actual, readCharacterBundle: mocks.readBundle, resolveRig: mocks.resolveRig }
})

vi.mock('../../../packages/api/src/lib/character-artifact-storage', () => ({
  createCharacterArtifactStorage: () => ({ put: mocks.put, getVerified: mocks.getVerified }),
}))

import { FACTORY_STATES } from '@pathfinder/character-factory'
import { importCharacterBundle, parseCharacterImportBundle } from './character-import'

const spec = {
  schemaVersion: 1,
  characterId: 'tochi-draft',
  version: 1,
  revision: 1,
  displayName: 'Tochi draft',
  rigFamily: 'morph-v1',
  source: {
    kind: 'imported',
    sourceUrl: 'https://example.test/tochi.svg',
    sourceRevision: 'draft-1',
    license: 'CC0',
    attribution: 'Fixture producer',
    importedAt: '2026-09-19T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    mediaType: 'image/svg+xml',
    byteLength: 10,
  },
  masterReference: 'source/tochi.svg',
  protectedTraits: ['warm expression'],
  slotMap: {},
  supportedStates: [...FACTORY_STATES],
  status: 'candidate',
} as const

function bytes(overrides: Record<string, unknown> = {}) {
  return new TextEncoder().encode(
    JSON.stringify({
      kind: 'pathfinder-character-bundle',
      spec: { ...spec, ...overrides },
      assets: [],
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveRig.mockReturnValue({ familyId: 'morph-v1' })
  mocks.readBundle.mockResolvedValue(spec)
  mocks.venue.mockResolvedValue({ id: 'venue-1' })
  mocks.character.mockRejectedValue(new ActionError('NOT_FOUND', 'missing'))
  mocks.prepare.mockResolvedValue({ job: { id: 'job-1', status: 'QUEUED' }, replayed: false })
  mocks.put.mockResolvedValue({
    kind: 'character-bundle-content-v1',
    sha256: 'b'.repeat(64),
    byteLength: 100,
    characterId: spec.characterId,
    characterVersion: 1,
  })
  mocks.claim.mockResolvedValue({ state: 'claimed', job: { leaseToken: 'lease-1' } })
  mocks.complete.mockResolvedValue({ id: 'job-1' })
  mocks.submit.mockResolvedValue({ brief: { id: 'brief-1' }, replayed: false })
})

describe('verified Bot Maker character import', () => {
  it('rejects malformed bundles before any persistence', async () => {
    await expect(parseCharacterImportBundle(new TextEncoder().encode('{}'))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(mocks.venue).not.toHaveBeenCalled()
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it('checks tenant and venue before storage', async () => {
    mocks.venue.mockResolvedValue(null)
    await expect(
      importCharacterBundle({
        tenantId: 'tenant-1',
        venueId: 'wrong',
        requestId: 'req-1',
        brief: 'Review',
        rationale: 'Source',
        sourceProvenance: 'GENERATED',
        bytes: bytes(),
        actorId: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('stores, completes, and submits one review candidate', async () => {
    await expect(
      importCharacterBundle({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: 'req-1',
        brief: 'Review',
        rationale: 'Source',
        sourceProvenance: 'GENERATED',
        bytes: bytes(),
        actorId: 'admin-1',
      }),
    ).resolves.toMatchObject({ briefId: 'brief-1', jobId: 'job-1' })
    expect(mocks.put).toHaveBeenCalledOnce()
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.submit).toHaveBeenCalledOnce()
  })

  it('fails closed when a replay has different review metadata', async () => {
    mocks.character.mockResolvedValue({
      status: 'REVIEW',
      spec,
      assetStorageReference: {
        kind: 'character-bundle-content-v1',
        sha256: 'b'.repeat(64),
        byteLength: 100,
        characterId: spec.characterId,
        characterVersion: 1,
      },
    })
    mocks.getVerified.mockResolvedValue({ spec })
    mocks.job.mockResolvedValue({
      id: 'job-1',
      action: 'CREATE_FROM_IMPORT',
      status: 'SUCCEEDED',
      customCharacterId: spec.characterId,
      requestPayload: {
        characterId: spec.characterId,
        sourceAssetReference: spec.masterReference,
        sourceSha256: spec.source.sha256,
      },
    })
    mocks.brief.mockResolvedValue({
      id: 'brief-1',
      brief: 'Different',
      rationale: 'Source',
      sourceProvenance: 'GENERATED',
    })
    await expect(
      importCharacterBundle({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: 'req-1',
        brief: 'Review',
        rationale: 'Source',
        sourceProvenance: 'GENERATED',
        bytes: bytes(),
        actorId: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('preserves an exact successful replay without reopening or resubmitting review', async () => {
    const uploaded = bytes()
    const digest = createHash('sha256').update(uploaded).digest('hex')
    const reference = {
      kind: 'character-bundle-content-v1',
      sha256: digest,
      byteLength: uploaded.byteLength,
      characterId: spec.characterId,
      characterVersion: 1,
    }
    mocks.character.mockResolvedValue({ status: 'REVIEW', spec, assetStorageReference: reference })
    mocks.getVerified.mockResolvedValue({ spec })
    mocks.job.mockResolvedValue({
      id: 'job-1',
      action: 'CREATE_FROM_IMPORT',
      status: 'SUCCEEDED',
      customCharacterId: spec.characterId,
      requestPayload: {
        characterId: spec.characterId,
        sourceAssetReference: spec.masterReference,
        sourceSha256: spec.source.sha256,
      },
    })
    mocks.brief.mockResolvedValue({
      id: 'brief-1',
      brief: 'Review',
      rationale: 'Source',
      sourceProvenance: 'GENERATED',
    })
    await expect(
      importCharacterBundle({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: 'req-1',
        brief: 'Review',
        rationale: 'Source',
        sourceProvenance: 'GENERATED',
        bytes: uploaded,
        actorId: 'admin-1',
      }),
    ).resolves.toMatchObject({ briefId: 'brief-1', jobId: 'job-1', replayed: true })
    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.submit).not.toHaveBeenCalled()
  })
})
