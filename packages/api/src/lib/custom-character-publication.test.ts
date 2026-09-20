import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCharacterBundle,
  FACTORY_STATES,
  type CharacterSpec,
  type CharacterExportArtifact,
} from '@pathfinder/character-factory'
import {
  CharacterRuntimePackSchema,
  RuntimePackStateSchema,
  canonicalCharacterRuntimePack,
} from '@pathfinder/contracts/character-runtime-pack'
import { nativeCoreVisibleStateHash } from '@pathfinder/contracts/native-venue-deployment'
import type { CustomCharacterPublicationEvidence } from '@pathfinder/db'
import { createCharacterArtifactStorage } from './character-artifact-storage'

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), evidence: vi.fn() }))
vi.mock('@pathfinder/db', async (original) => ({
  ...(await original<typeof import('@pathfinder/db')>()),
  resolveNativeGuestReadSnapshotAction: mocks.snapshot,
  readCustomCharacterPublicationEvidence: mocks.evidence,
  withTenantIsolationBypass: (run: () => unknown) => run(),
}))
import {
  readPublishedCustomCharacterAsset,
  resolvePublishedCustomCharacterProjection,
  verifyNativeCustomCharacterPublication,
  type CustomCharacterPublicationDependencies,
} from './custom-character-publication'

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const releaseId = '11111111-1111-4111-8111-111111111111'
const scope = { tenantId: 'tenant-a', venueId: 'venue-a', venueSlug: 'venue-a' }

async function fixture(malformedPng = false) {
  const bytes = malformedPng
    ? Uint8Array.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 64, 0, 0, 0, 64, 8,
        6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ])
    : new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="#147a86"/></svg>',
      )
  const mediaType = malformedPng ? ('image/png' as const) : ('image/svg+xml' as const)
  const ext = malformedPng ? 'png' : 'svg'
  const spec: CharacterSpec = {
    schemaVersion: 1,
    characterId: 'test-character',
    version: 1,
    revision: 1,
    displayName: 'Prepared character',
    rigFamily: 'morph-v1',
    source: {
      kind: 'imported',
      sourceUrl: 'https://private.example.invalid/master',
      sourceRevision: 'private-source-revision',
      license: 'fixture',
      attribution: 'fixture',
      importedAt: '2026-09-11T00:00:00.000Z',
      sha256: sha(bytes),
      mediaType,
      byteLength: bytes.length,
    },
    masterReference: `master.${ext}`,
    protectedTraits: [],
    slotMap: { body: `body.${ext}` },
    supportedStates: FACTORY_STATES,
    status: 'candidate',
  }
  const assets = [
    { path: `master.${ext}`, mediaType, bytes, role: 'master' as const },
    { path: `body.${ext}`, mediaType, bytes, role: 'slot' as const, slot: 'body' },
    { path: `fallback.${ext}`, mediaType, bytes, role: 'fallback' as const },
  ]
  const supportedStates = [
    'idle',
    'attention',
    'listening',
    'thinking',
    'speaking',
    'success',
    'error',
  ] as const
  const pack = CharacterRuntimePackSchema.parse({
    schemaVersion: 1,
    renderer: 'family-rig-v1',
    characterId: spec.characterId,
    characterVersion: 1,
    sourceSha256: spec.source.sha256,
    family: 'morph-v1',
    capability: 'rigid-source',
    assets: assets.map((asset, index) => ({
      id: ['master', 'body', 'fallback'][index],
      path: asset.path,
      mediaType,
      width: 64,
      height: 64,
      bytes: bytes.length,
      sha256: sha(bytes),
    })),
    canvas: { width: 64, height: 64 },
    safeBounds: { x: 0, y: 0, width: 64, height: 64 },
    origin: { x: 32, y: 32 },
    anchors: { lookAt: { x: 32, y: 20 }, embers: { x: 32, y: 40 } },
    sourceAssetId: 'master',
    staticFallbackAssetId: 'fallback',
    reducedMotionFallbackAssetId: 'fallback',
    layers: [{ role: 'body', assetId: 'body' }],
    supportedStates,
    stateFallbacks: Object.fromEntries(
      RuntimePackStateSchema.options
        .filter((state) => !supportedStates.some((s) => s === state))
        .map((state) => [state, 'idle']),
    ),
    supportedContexts: ['venue-text-chat'],
  })
  const candidate = await createCharacterBundle(spec, assets, pack)
  const exportedSpec = { ...spec, revision: 2, status: 'exported' as const }
  const exported = await createCharacterBundle(exportedSpec, assets, pack)
  const reference = (bundle: CharacterExportArtifact) => ({
    kind: 'character-bundle-v1' as const,
    bucket: 'fixture',
    objectKey: `character-factory/tenant-a/venue-a/test-character/v1/${bundle.sha256}.character.json`,
    sha256: bundle.sha256,
    byteLength: bundle.byteLength,
    mediaType: bundle.mediaType,
    characterId: spec.characterId,
    characterVersion: 1,
    versionId: bundle.sha256,
  })
  const records = new Map([candidate, exported].map((bundle) => [bundle.sha256, bundle]))
  const transport = {
    send: vi.fn(
      async (command: { input: { Key?: string | undefined; VersionId?: string | undefined } }) => {
        const contentIdentity = command.input.Key?.split('/').at(-1)?.split('.')[0]
        const found = records.get(command.input.VersionId ?? contentIdentity ?? '')
        if (!found || command.input.Key !== reference(found).objectKey)
          throw new Error('Missing immutable version')
        return {
          ContentLength: found.byteLength,
          ContentType: found.mediaType,
          Metadata: { 'pathfinder-sha256': found.sha256 },
          Body: (async function* () {
            yield found.bytes
          })(),
        }
      },
    ),
  }
  const storage = createCharacterArtifactStorage(transport, 'fixture')
  const binding = {
    schemaVersion: 1 as const,
    characterId: spec.characterId,
    decisionId: 'decision-a',
    exportJobId: 'job-a',
    characterVersion: 1,
    characterRevision: 2,
    sourceSha256: spec.source.sha256,
    artifactSha256: exported.sha256,
    artifactVersionId: exported.sha256,
    runtimePackSha256: sha(canonicalCharacterRuntimePack(pack)),
  }
  const evidence: CustomCharacterPublicationEvidence = {
    binding,
    artifactReference: reference(exported),
    spec: exportedSpec,
    runtimePack: pack,
    acceptedCandidate: {
      artifactReference: reference(candidate),
      spec,
      artifactFingerprint: 'a'.repeat(64),
    },
  }
  const configuration = {
    presentationMode: 'CHARACTER' as const,
    personalityMode: 'PRESET' as const,
    tonePreset: 'friendly' as const,
    tonePresetVersion: 1 as const,
    responseDepth: 'BALANCED' as const,
    personalityProfileId: null,
    characterKey: null,
    customCharacterId: spec.characterId,
    publicDisplayName: 'Published A',
    greeting: null,
    voiceProfileId: null,
  }
  const state = {
    venue: {
      name: 'Venue A',
      slug: 'venue-a',
      description: null,
      guideNotes: null,
      aiGuideNotes: null,
      aiFeaturedPlaceId: null,
      aiTone: 'FRIENDLY',
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      aiGuideName: null,
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      category: null,
      guideMode: 'location_aware',
      defaultCenterLat: null,
      defaultCenterLng: null,
      geoBoundary: null,
      isActive: true,
    },
    venueBotConfiguration: configuration,
    customCharacterPublication: binding,
    places: [],
    knowledgeEntries: [],
    generalizedModules: [],
  }
  expect(nativeCoreVisibleStateHash(state)).toMatch(/^[a-f0-9]{64}$/)
  mocks.snapshot.mockResolvedValue({ path: 'NATIVE', releaseId, state })
  mocks.evidence.mockResolvedValue(evidence)
  const client = {
    venue: {
      findFirst: vi.fn().mockResolvedValue({ id: scope.venueId, tenantId: scope.tenantId }),
    },
    tenantFeatureFlag: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { flagKey: 'venue-character-mode-v1' },
          { flagKey: 'character-registry-v1' },
        ]),
    },
  }
  const dependencies: CustomCharacterPublicationDependencies = {
    client: client as unknown as NonNullable<CustomCharacterPublicationDependencies['client']>,
    storage,
    featureEnabled: () => true,
    rateLimit: vi.fn().mockResolvedValue(true),
    environment: { NATIVE_GUEST_CONTENT_READ_ENABLED: 'true', RAILWAY_ENVIRONMENT: 'staging' },
  }
  const assetInput = {
    venueSlug: 'venue-a',
    releaseId,
    runtimePackSha256: binding.runtimePackSha256,
    assetPath: 'body.png',
  }
  return {
    evidence,
    dependencies,
    client,
    transport,
    records,
    state,
    assetInput,
    pack,
    assets,
    spec,
    reference,
  }
}

describe('published custom character API boundary', () => {
  beforeEach(() => vi.clearAllMocks())
  it('verifies ACCEPT/export and exposes only exact PNG derivatives and released presentation', async () => {
    const f = await fixture()
    expect(
      (
        await f.dependencies.storage!.getVerified({
          ...scope,
          reference: f.evidence.artifactReference,
          expectedSpec: f.evidence.spec,
        })
      ).runtimePack,
    ).toEqual(f.pack)
    await expect(
      verifyNativeCustomCharacterPublication({ ...scope, ...f.evidence }, f.dependencies),
    ).resolves.toBeUndefined()
    const projection = await resolvePublishedCustomCharacterProjection(scope, f.dependencies)
    expect(projection?.presentation).toMatchObject({
      mode: 'CHARACTER',
      displayName: 'Published A',
    })
    expect(JSON.stringify(projection)).not.toMatch(
      /private\.example|sourceSha256|sourceRevision|objectKey|versionId|characterVersion/,
    )
    expect(
      projection?.character?.familyRig?.assets.every((asset) => asset.mediaType === 'image/png'),
    ).toBe(true)
    const image = await readPublishedCustomCharacterAsset(f.assetInput, f.dependencies)
    expect(image?.mediaType).toBe('image/png')
    expect(await sharp(image!.bytes).metadata()).toMatchObject({
      format: 'png',
      width: 64,
      height: 64,
    })
    expect(new TextDecoder().decode(image!.bytes)).not.toContain('<svg')
    expect(f.dependencies.rateLimit).toHaveBeenCalledWith(
      'ratelimit:custom-character-assets:tenant-a:venue-a',
      4096,
      60,
    )
    expect(mocks.evidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requireCurrentCandidate: false }),
    )
  })
  it('rejects a different but valid export pack after ACCEPT', async () => {
    const f = await fixture()
    const changed = { ...f.pack, origin: { x: 20, y: 20 } }
    const bundle = await createCharacterBundle(f.evidence.spec, f.assets, changed)
    f.records.set(bundle.sha256, bundle)
    const evidence = {
      ...f.evidence,
      runtimePack: changed,
      artifactReference: f.reference(bundle),
      binding: {
        ...f.evidence.binding,
        artifactSha256: bundle.sha256,
        artifactVersionId: bundle.sha256,
        runtimePackSha256: sha(canonicalCharacterRuntimePack(changed)),
      },
    }
    await expect(
      verifyNativeCustomCharacterPublication({ ...scope, ...evidence }, f.dependencies),
    ).rejects.toThrow('ACCEPTed')
  })
  it('fails closed when publication receives a content-addressed artifact reference', async () => {
    const f = await fixture()
    const contentReference = (bundle: CharacterExportArtifact) => {
      const { versionId, ...reference } = f.reference(bundle)
      expect(versionId).toBeTruthy()
      return { ...reference, kind: 'character-bundle-content-v1' as const }
    }
    const evidence = {
      ...f.evidence,
      artifactReference: contentReference(f.records.get(f.evidence.artifactReference.sha256)!),
      acceptedCandidate: {
        ...f.evidence.acceptedCandidate,
        artifactReference: contentReference(
          f.records.get(f.evidence.acceptedCandidate.artifactReference.sha256)!,
        ),
      },
    }
    await expect(
      verifyNativeCustomCharacterPublication({ ...scope, ...evidence }, f.dependencies),
    ).rejects.toThrow('Published runtime pack differs')
  })
  it('rejects header-only PNGs with valid bundle and declared dimensions during full decode', async () => {
    const f = await fixture(true)
    await expect(
      verifyNativeCustomCharacterPublication({ ...scope, ...f.evidence }, f.dependencies),
    ).rejects.toThrow()
    expect(await resolvePublishedCustomCharacterProjection(scope, f.dependencies)).toMatchObject({
      character: null,
      presentation: { mode: 'CLASSIC', character: null },
    })
  })
  it.each(['missing-object', 'missing-receipt', 'revoked-during-read'] as const)(
    'returns neutral Classic after selecting a native custom head when %s',
    async (failure) => {
      const f = await fixture()
      if (failure === 'missing-object') f.records.clear()
      if (failure === 'missing-receipt')
        mocks.evidence.mockRejectedValue(new Error('Missing audit evidence'))
      if (failure === 'revoked-during-read')
        mocks.snapshot
          .mockResolvedValueOnce({ path: 'NATIVE', releaseId, state: f.state })
          .mockResolvedValue({ path: 'LEGACY', state: null })
      expect(await resolvePublishedCustomCharacterProjection(scope, f.dependencies)).toMatchObject({
        character: null,
        presentation: { mode: 'CLASSIC', character: null, displayName: null, greeting: null },
      })
    },
  )
  it.each([
    'disabled',
    'tenant-disabled',
    'inactive',
    'legacy',
    'dark',
    'stale-release',
    'wrong-hash',
    'unknown-asset',
    'rate-limit',
    'missing-object',
    'revoked-during-read',
  ] as const)('fails closed for %s', async (failure) => {
    const f = await fixture()
    if (failure === 'disabled') f.dependencies.featureEnabled = () => false
    if (failure === 'tenant-disabled') f.client.tenantFeatureFlag.findMany.mockResolvedValue([])
    if (failure === 'inactive') f.client.venue.findFirst.mockResolvedValue(null)
    if (failure === 'legacy' || failure === 'dark')
      mocks.snapshot.mockResolvedValue({ path: failure.toUpperCase(), state: null })
    if (failure === 'stale-release') f.assetInput.releaseId = '22222222-2222-4222-8222-222222222222'
    if (failure === 'wrong-hash') f.assetInput.runtimePackSha256 = 'b'.repeat(64)
    if (failure === 'unknown-asset') f.assetInput.assetPath = 'unknown.png'
    if (failure === 'rate-limit') f.dependencies.rateLimit = vi.fn().mockResolvedValue(false)
    if (failure === 'missing-object') f.records.clear()
    if (failure === 'revoked-during-read')
      mocks.snapshot
        .mockResolvedValueOnce({ path: 'NATIVE', releaseId, state: f.state })
        .mockResolvedValue({ path: 'LEGACY', state: null })
    expect(await readPublishedCustomCharacterAsset(f.assetInput, f.dependencies)).toBeNull()
    if (
      [
        'disabled',
        'tenant-disabled',
        'inactive',
        'legacy',
        'dark',
        'stale-release',
        'wrong-hash',
        'unknown-asset',
        'rate-limit',
      ].includes(failure)
    )
      expect(f.transport.send).not.toHaveBeenCalled()
  })
})
