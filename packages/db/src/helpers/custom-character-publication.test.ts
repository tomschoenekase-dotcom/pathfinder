import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FACTORY_STATES, type CharacterSpec } from '@pathfinder/character-factory'
import { completeCharacterFactoryJobAction } from './custom-character-factory-actions'
import {
  CharacterRuntimePackSchema,
  RuntimePackStateSchema,
  canonicalCharacterRuntimePack,
} from '@pathfinder/contracts/character-runtime-pack'
import {
  createVerifiedCharacterExportReceipt,
  readCustomCharacterPublicationEvidence,
  verifiedCharacterExportReceiptHash,
} from './custom-character-publication'

function fixture() {
  const spec: CharacterSpec = {
    schemaVersion: 1,
    characterId: 'test-character',
    version: 1,
    revision: 2,
    displayName: 'Test',
    rigFamily: 'morph-v1',
    source: {
      kind: 'imported',
      sourceUrl: 'https://example.invalid/source.svg',
      sourceRevision: '1',
      license: 'test',
      attribution: 'test',
      importedAt: '2026-09-11T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      mediaType: 'image/svg+xml',
      byteLength: 100,
    },
    masterReference: 'private/source.svg',
    protectedTraits: [],
    slotMap: { body: 'body.svg' },
    supportedStates: FACTORY_STATES,
    status: 'exported',
  }
  const runtimePack = CharacterRuntimePackSchema.parse({
    schemaVersion: 1,
    renderer: 'family-rig-v1',
    characterId: spec.characterId,
    characterVersion: 1,
    sourceSha256: spec.source.sha256,
    family: 'morph-v1',
    capability: 'rigid-source',
    assets: [
      {
        id: 'body',
        path: 'body.svg',
        mediaType: 'image/svg+xml',
        width: 64,
        height: 64,
        bytes: 100,
        sha256: 'b'.repeat(64),
      },
    ],
    canvas: { width: 64, height: 64 },
    safeBounds: { x: 0, y: 0, width: 64, height: 64 },
    origin: { x: 32, y: 32 },
    anchors: { lookAt: { x: 32, y: 20 }, embers: { x: 32, y: 40 } },
    sourceAssetId: 'body',
    staticFallbackAssetId: 'body',
    reducedMotionFallbackAssetId: 'body',
    layers: [{ role: 'body', assetId: 'body' }],
    supportedStates: [...RuntimePackStateSchema.options],
    stateFallbacks: {},
    supportedContexts: ['venue-text-chat'],
  })
  const artifactReference = {
    kind: 'character-bundle-v1',
    bucket: 'private',
    objectKey: 'private/export.json',
    sha256: 'c'.repeat(64),
    byteLength: 1000,
    mediaType: 'application/vnd.pathfinder.character+json',
    characterId: spec.characterId,
    characterVersion: 1,
    versionId: 'object-version-a',
  }
  const receipt = createVerifiedCharacterExportReceipt({
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    exportJobId: 'job-a',
    spec,
    artifactReference,
    runtimePack,
    acceptedCandidate: {
      artifactReference,
      spec: { ...spec, revision: 1, status: 'candidate' },
      artifactFingerprint: 'e'.repeat(64),
    },
  })
  const binding = {
    schemaVersion: 1 as const,
    characterId: spec.characterId,
    decisionId: 'decision-a',
    exportJobId: 'job-a',
    characterVersion: 1,
    characterRevision: 2,
    sourceSha256: spec.source.sha256,
    artifactSha256: artifactReference.sha256,
    artifactVersionId: artifactReference.versionId,
    runtimePackSha256: createHash('sha256')
      .update(canonicalCharacterRuntimePack(runtimePack))
      .digest('hex'),
  }
  const decision = {
    candidateVersion: 1,
    candidateRevision: 1,
    artifactFingerprint: 'e'.repeat(64),
  }
  const job = {
    id: 'job-a',
    baseVersion: 1,
    baseRevision: 1,
    resultVersion: 1,
    resultRevision: 2,
    cancelRequestedAt: null,
    resultPayload: { verifiedExportReceipt: receipt },
  }
  const character = {
    status: 'REVIEW',
    version: 1,
    revision: 2,
    assetStorageReference: artifactReference,
    capabilityMetadata: { characterFactory: { spec } },
  }
  const reader = {
    characterCandidateReviewDecision: { findFirst: vi.fn().mockResolvedValue(decision) },
    characterFactoryJob: { findFirst: vi.fn().mockResolvedValue(job) },
    customCharacter: { findFirst: vi.fn().mockResolvedValue(character) },
    auditLog: { findFirst: vi.fn().mockResolvedValue({ id: 'server-audit' }) },
  }
  const read = (requireCurrentCandidate = true) =>
    readCustomCharacterPublicationEvidence(
      reader as unknown as Parameters<typeof readCustomCharacterPublicationEvidence>[0],
      { tenantId: 'tenant-a', venueId: 'venue-a', binding, requireCurrentCandidate },
    )
  return { receipt, binding, decision, job, character, reader, read }
}

describe('immutable custom character publication evidence', () => {
  it('replaces spoofed worker receipts with server evidence while retaining ordinary result fields', async () => {
    const f = fixture()
    const before = {
      version: 1,
      revision: 1,
      assetStorageReference: f.receipt.acceptedCandidate.artifactReference,
      previewStorageReference: null,
      capabilityMetadata: {
        characterFactory: { schemaVersion: 1, spec: f.receipt.acceptedCandidate.spec },
      },
    }
    const tx = {
      characterFactoryJob: {
        findFirst: vi.fn().mockResolvedValue({
          ...f.job,
          action: 'EXPORT',
          customCharacterId: f.binding.characterId,
          createdBy: 'operator',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...f.job, status: 'SUCCEEDED' }),
      },
      customCharacter: {
        findFirst: vi.fn().mockResolvedValue(before),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn() },
    }
    const order: string[] = []
    const client = {
      $transaction: vi.fn(async (run: (value: typeof tx) => Promise<unknown>) => {
        order.push('transaction')
        return run(tx)
      }),
    }
    await completeCharacterFactoryJobAction(
      {
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        requestId: 'request-a',
        leaseToken: 'owned-lease',
        resultPayload: { diagnosticCount: 2, verifiedExportReceipt: { workerApproved: true } },
        characterSpec: f.receipt.spec,
        assetStorageReference: f.receipt.artifactReference,
        actor: { id: 'operator', role: 'PLATFORM_ADMIN' },
      },
      client as unknown as Parameters<typeof completeCharacterFactoryJobAction>[1],
      {
        verifyArtifact: async () => {
          order.push('storage')
          return {
            reference: f.receipt.artifactReference,
            spec: f.receipt.spec,
            runtimePack: f.receipt.runtimePack,
          }
        },
      },
    )
    expect(order).toEqual(['storage', 'transaction'])
    const persisted = tx.characterFactoryJob.updateMany.mock.calls[0]?.[0].data.resultPayload
    expect(persisted.diagnosticCount).toBe(2)
    expect(persisted.verifiedExportReceipt).not.toHaveProperty('workerApproved')
    expect(persisted.verifiedExportReceipt.acceptedCandidate.spec).toEqual(
      before.capabilityMetadata.characterFactory.spec,
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'character-factory.export-verified',
          afterState: {
            receiptSha256: verifiedCharacterExportReceiptHash(persisted.verifiedExportReceipt),
          },
        }),
      }),
    )
  })
  it('requires exact tenant/venue ACCEPT/export/job and server receipt audit digest', async () => {
    const f = fixture()
    await expect(f.read()).resolves.toMatchObject({
      binding: f.binding,
      spec: { version: 1, revision: 2 },
    })
    expect(f.reader.characterCandidateReviewDecision.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        id: 'decision-a',
        customCharacterId: 'test-character',
        decision: 'ACCEPT',
        resultingJobId: 'job-a',
      },
    })
    expect(f.reader.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          afterState: {
            path: ['receiptSha256'],
            equals: verifiedCharacterExportReceiptHash(f.receipt),
          },
        }),
      }),
    )
  })
  it('rejects a historical spoofed payload without a server-created verification event', async () => {
    const f = fixture()
    f.reader.auditLog.findFirst.mockResolvedValue(null)
    await expect(f.read()).rejects.toThrow('server verification')
  })
  it('preserves released A when draft B advances, but forbids publishing stale A anew', async () => {
    const f = fixture()
    f.character.version = 2
    f.character.revision = 3
    await expect(f.read(false)).resolves.toMatchObject({ spec: { version: 1, revision: 2 } })
    await expect(f.read(true)).rejects.toThrow('newer custom character draft')
  })
  it('rejects content-addressed artifacts against the version-pinned publication binding', async () => {
    const f = fixture()
    expect(f.receipt.artifactReference.kind).toBe('character-bundle-v1')
    if (f.receipt.artifactReference.kind !== 'character-bundle-v1') throw new Error('fixture shape')
    const { versionId, ...contentReference } = f.receipt.artifactReference
    expect(versionId).toBeTruthy()
    f.receipt.artifactReference = {
      ...contentReference,
      kind: 'character-bundle-content-v1',
    }
    f.receipt.acceptedCandidate.artifactReference = {
      ...contentReference,
      kind: 'character-bundle-content-v1',
    }
    await expect(f.read(false)).rejects.toThrow('binding changed')
  })
  it.each([
    'decision',
    'job',
    'character',
    'archive',
    'revision',
    'source',
    'object-version',
    'pack',
    'receipt-scope',
  ] as const)('rejects missing or changed %s authority', async (failure) => {
    const f = fixture()
    if (failure === 'decision')
      f.reader.characterCandidateReviewDecision.findFirst.mockResolvedValue(null)
    if (failure === 'job') f.reader.characterFactoryJob.findFirst.mockResolvedValue(null)
    if (failure === 'character') f.reader.customCharacter.findFirst.mockResolvedValue(null)
    if (failure === 'archive') f.character.status = 'ARCHIVED'
    if (failure === 'revision') f.job.baseRevision = 2
    if (failure === 'source') f.binding.sourceSha256 = 'd'.repeat(64)
    if (failure === 'object-version') f.binding.artifactVersionId = 'object-version-b'
    if (failure === 'pack') f.binding.runtimePackSha256 = 'd'.repeat(64)
    if (failure === 'receipt-scope') f.receipt.tenantId = 'foreign'
    await expect(f.read(false)).rejects.toThrow()
  })
})
