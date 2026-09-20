import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { isFeatureEnabled, TOCHI_TENANT_FLAG_KEYS } from '@pathfinder/config'
import {
  db,
  readCustomCharacterPublicationEvidence,
  resolveNativeGuestReadSnapshotAction,
  withTenantIsolationBypass,
  type CustomCharacterPublicationEvidence,
} from '@pathfinder/db'
import { PublicVenueBotPresentation } from '@pathfinder/contracts/venue-bot-configuration'
import { nativeCoreVisibleStateHash } from '@pathfinder/contracts/native-venue-deployment'
import { PublicCharacterProjectionSchema } from '@pathfinder/contracts/character-system'
import {
  canonicalCharacterRuntimePack,
  CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES,
  CHARACTER_RUNTIME_PACK_TOTAL_MAX_BYTES,
  createPublicFamilyRig,
  PublicFamilyRigSchema,
  type CharacterRuntimePack,
} from '@pathfinder/contracts/character-runtime-pack'
import {
  readCharacterRuntimeAsset,
  readCharacterRuntimePack,
  type CharacterExportArtifact,
} from '@pathfinder/character-factory'
import { createCharacterArtifactStorage } from './character-artifact-storage'
import { checkRateLimit } from './rate-limit'

type Scope = { tenantId: string; venueId: string; venueSlug: string }
type Client = Pick<
  typeof db,
  | 'venue'
  | 'tenantFeatureFlag'
  | 'nativeVenueDeploymentHead'
  | 'nativeVenueDeploymentEvaluationEvidence'
  | 'customCharacter'
  | 'characterFactoryJob'
  | 'characterCandidateReviewDecision'
  | 'auditLog'
>
export type CustomCharacterPublicationDependencies = {
  client?: Client
  storage?: Pick<ReturnType<typeof createCharacterArtifactStorage>, 'getVerified'>
  environment?: Record<string, string | undefined>
  featureEnabled?: (key: 'venueCharacterMode' | 'characterRegistry') => boolean
  rateLimit?: typeof checkRateLimit
}
const HASH = /^[a-f0-9]{64}$/
const RELEASE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_PIXELS = 16_777_216
const MAX_FILE_BYTES = CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES
const MAX_PACK_BYTES = CHARACTER_RUNTIME_PACK_TOTAL_MAX_BYTES
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

function artifact(
  value: Awaited<ReturnType<ReturnType<typeof createCharacterArtifactStorage>['getVerified']>>,
): CharacterExportArtifact {
  return { ...value.reference, schemaVersion: 1, bytes: value.bytes }
}

async function verifiedBundles(
  input: CustomCharacterPublicationEvidence & { tenantId: string; venueId: string },
  dependencies: CustomCharacterPublicationDependencies,
) {
  const storage = dependencies.storage ?? createCharacterArtifactStorage()
  const [exported, accepted] = await Promise.all([
    storage.getVerified({
      tenantId: input.tenantId,
      venueId: input.venueId,
      reference: input.artifactReference,
      expectedSpec: input.spec,
    }),
    storage.getVerified({
      tenantId: input.tenantId,
      venueId: input.venueId,
      reference: input.acceptedCandidate.artifactReference,
      expectedSpec: input.acceptedCandidate.spec,
    }),
  ])
  const exportedArtifact = artifact(exported)
  const [exportPack, candidatePack] = await Promise.all([
    readCharacterRuntimePack(exportedArtifact),
    readCharacterRuntimePack(artifact(accepted)),
  ])
  const canonical = canonicalCharacterRuntimePack(exportPack.runtimePack)
  if (
    canonical !== canonicalCharacterRuntimePack(candidatePack.runtimePack) ||
    canonical !== canonicalCharacterRuntimePack(input.runtimePack) ||
    digest(canonical) !== input.binding.runtimePackSha256 ||
    exported.reference.sha256 !== input.binding.artifactSha256 ||
    exported.reference.kind !== 'character-bundle-v1' ||
    exported.reference.versionId !== input.binding.artifactVersionId
  ) {
    throw new Error('Published runtime pack differs from the ACCEPTed immutable candidate.')
  }
  if (
    exportPack.runtimePack.assets.reduce((sum, asset) => sum + asset.width * asset.height, 0) >
    MAX_PIXELS
  ) {
    throw new Error('Character runtime pack exceeds the aggregate decode budget.')
  }
  return { artifact: exportedArtifact, pack: exportPack.runtimePack }
}

function assertRasterOnlySvg(bytes: Uint8Array) {
  const svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  // Conservative pre-rasterization admission: no stylesheet, external-resource,
  // entity, processing-instruction, or namespaced element surface reaches libvips.
  const withoutDeclaration = svg.replace(
    /^\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?\s*\?>/i,
    '',
  )
  if (
    /<!|<\?|\bstyle\s*=|\bon\w+\s*=|\b(?:href|src)\s*=|url\s*\(|&(?!(?:amp|lt|gt|quot|apos);)/iu.test(
      withoutDeclaration,
    )
  )
    throw new Error('SVG rasterization input is not self-contained.')
  const tags = withoutDeclaration.matchAll(/<\s*\/?\s*([A-Za-z][\w:.-]*)/g)
  const permitted = new Set([
    'svg',
    'g',
    'path',
    'circle',
    'ellipse',
    'rect',
    'line',
    'polyline',
    'polygon',
    'title',
    'desc',
    'defs',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
  ])
  for (const tag of tags)
    if (!permitted.has(tag[1]!))
      throw new Error('SVG rasterization input has unsupported elements.')
}

async function rasterAsset(
  bundle: CharacterExportArtifact,
  asset: CharacterRuntimePack['assets'][number],
  seconds: number,
) {
  const verified = await readCharacterRuntimeAsset(bundle, { assetId: asset.id })
  if (verified.bytes.byteLength > MAX_FILE_BYTES)
    throw new Error('Character asset exceeds input bounds.')
  if (asset.mediaType === 'image/svg+xml') assertRasterOnlySvg(verified.bytes)
  const rendered = await sharp(verified.bytes, {
    limitInputPixels: MAX_PIXELS,
    failOn: 'error',
    animated: false,
  })
    .timeout({ seconds })
    .png()
    .toBuffer({ resolveWithObject: true })
  if (
    rendered.info.width !== asset.width ||
    rendered.info.height !== asset.height ||
    rendered.data.byteLength > MAX_FILE_BYTES
  )
    throw new Error('Decoded character dimensions or output budget differ from the reviewed pack.')
  return {
    asset: {
      ...asset,
      path: `${asset.id}.png`,
      mediaType: 'image/png' as const,
      bytes: rendered.data.byteLength,
      sha256: digest(rendered.data),
    },
    bytes: Uint8Array.from(rendered.data),
  }
}

async function rasterPack(value: Awaited<ReturnType<typeof verifiedBundles>>) {
  const deadline = Date.now() + 5_000
  const rendered = []
  let total = 0
  for (const asset of value.pack.assets) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Character rasterization deadline exceeded.')
    const result = await rasterAsset(
      value.artifact,
      asset,
      Math.max(1, Math.ceil(remaining / 1000)),
    )
    total += result.bytes.byteLength
    if (total > MAX_PACK_BYTES) throw new Error('Character PNG derivatives exceed the pack budget.')
    rendered.push(result)
  }
  return rendered
}

/** No storage I/O occurs inside the native deployment transaction. */
export async function verifyNativeCustomCharacterPublication(
  input: CustomCharacterPublicationEvidence & { tenantId: string; venueId: string },
  dependencies: CustomCharacterPublicationDependencies = {},
): Promise<void> {
  await rasterPack(await verifiedBundles(input, dependencies))
}

function enabled(dependencies: CustomCharacterPublicationDependencies) {
  const check = dependencies.featureEnabled ?? isFeatureEnabled
  return check('venueCharacterMode') && check('characterRegistry')
}

async function nativeSelection(scope: Scope, dependencies: CustomCharacterPublicationDependencies) {
  if (!enabled(dependencies) || !SLUG.test(scope.venueSlug) || scope.venueSlug.length > 191)
    return null
  const client = dependencies.client ?? db
  const venue = await client.venue.findFirst({
    where: { id: scope.venueId, tenantId: scope.tenantId, slug: scope.venueSlug, isActive: true },
    select: { id: true },
  })
  if (!venue) return null
  const keys = [TOCHI_TENANT_FLAG_KEYS.venueCharacterMode, TOCHI_TENANT_FLAG_KEYS.characterRegistry]
  const flags = await client.tenantFeatureFlag.findMany({
    where: { tenantId: scope.tenantId, flagKey: { in: keys }, enabled: true },
    select: { flagKey: true },
  })
  if (!keys.every((key) => flags.some((flag) => flag.flagKey === key))) return null
  const snapshot = await resolveNativeGuestReadSnapshotAction({
    client,
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    ...(dependencies.environment ? { environment: dependencies.environment } : {}),
  })
  const state = snapshot.state
  if (
    snapshot.path !== 'NATIVE' ||
    !snapshot.releaseId ||
    !state?.customCharacterPublication ||
    !state.venue.isActive ||
    state.venue.slug !== scope.venueSlug
  )
    return null
  return {
    snapshot: { ...snapshot, state, releaseId: snapshot.releaseId },
    binding: state.customCharacterPublication,
    stateHash: nativeCoreVisibleStateHash(state),
  }
}

async function authority(scope: Scope, dependencies: CustomCharacterPublicationDependencies) {
  const selected = await nativeSelection(scope, dependencies)
  if (!selected) return null
  const evidence = await readCustomCharacterPublicationEvidence(dependencies.client ?? db, {
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    binding: selected.binding,
    requireCurrentCandidate: false,
  })
  return { ...selected, evidence }
}

async function stillCurrent(
  scope: Scope,
  selected: NonNullable<Awaited<ReturnType<typeof authority>>>,
  dependencies: CustomCharacterPublicationDependencies,
) {
  const fresh = await authority(scope, dependencies)
  return Boolean(
    fresh &&
    fresh.snapshot.releaseId === selected.snapshot.releaseId &&
    fresh.stateHash === selected.stateHash &&
    fresh.evidence.binding.runtimePackSha256 === selected.evidence.binding.runtimePackSha256,
  )
}

export async function resolvePublishedCustomCharacterProjection(
  scope: Scope,
  dependencies: CustomCharacterPublicationDependencies = {},
) {
  let fallback: {
    character: null
    presentation: PublicVenueBotPresentation
    releaseId: string
    runtimePackSha256: string
  } | null = null
  try {
    const native = await nativeSelection(scope, dependencies)
    if (!native) return null
    // Once an exact native custom release is selected, an unavailable artifact or
    // receipt must never reveal a character from a newer mutable configuration.
    fallback = {
      character: null,
      presentation: PublicVenueBotPresentation.parse({
        mode: 'CLASSIC',
        displayName: null,
        greeting: null,
        personalityPreset: 'friendly',
        character: null,
      }),
      releaseId: native.snapshot.releaseId,
      runtimePackSha256: native.binding.runtimePackSha256,
    }
    const evidence = await readCustomCharacterPublicationEvidence(dependencies.client ?? db, {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      binding: native.binding,
      requireCurrentCandidate: false,
    })
    const selected = { ...native, evidence }
    const value = await verifiedBundles({ ...scope, ...selected.evidence }, dependencies)
    const rendered = await rasterPack(value)
    const familyRig = PublicFamilyRigSchema.parse({
      ...createPublicFamilyRig(value.pack),
      assets: rendered.map((item) => item.asset),
    })
    const releaseId = selected.snapshot.releaseId
    const runtimePackSha256 = selected.evidence.binding.runtimePackSha256
    const character = PublicCharacterProjectionSchema.parse({
      characterId: value.pack.characterId,
      displayName: selected.evidence.spec.displayName,
      assetPackId: `export-${selected.evidence.binding.exportJobId}`,
      assetPackVersion: `v${value.pack.characterVersion}-${runtimePackSha256.slice(0, 16)}`,
      renderer: 'family-rig-v1',
      familyRig,
      publicBasePath: `/characters/custom/${encodeURIComponent(scope.venueSlug)}/${releaseId}/${runtimePackSha256}`,
      assets: familyRig.assets.map(({ id, path, mediaType, width, height, bytes }) => ({
        id,
        path,
        mediaType,
        width,
        height,
        bytes,
      })),
      canvas: familyRig.canvas,
      anchors: familyRig.anchors,
      staticFallbackAssetId: familyRig.staticFallbackAssetId,
      reducedMotionFallbackAssetId: familyRig.reducedMotionFallbackAssetId,
      layers: {},
      states: Object.fromEntries(
        familyRig.supportedStates.map((state) => [state, { variant: state.toLowerCase() }]),
      ),
      stateFallbacks: familyRig.stateFallbacks,
      supportedContexts: familyRig.supportedContexts,
    })
    const configuration = selected.snapshot.state.venueBotConfiguration
    const presentation = PublicVenueBotPresentation.parse({
      mode: 'CHARACTER',
      displayName: configuration.publicDisplayName,
      greeting: configuration.greeting,
      personalityPreset: configuration.tonePreset,
      character,
    })
    if (!(await stillCurrent(scope, selected, dependencies))) return fallback
    return { character, presentation, releaseId, runtimePackSha256 }
  } catch {
    return fallback
  }
}

export async function readPublishedCustomCharacterAsset(
  input: { venueSlug: string; releaseId: string; runtimePackSha256: string; assetPath: string },
  dependencies: CustomCharacterPublicationDependencies = {},
): Promise<{ bytes: Uint8Array; mediaType: 'image/png' } | null> {
  if (
    !enabled(dependencies) ||
    !SLUG.test(input.venueSlug) ||
    input.venueSlug.length > 191 ||
    !RELEASE.test(input.releaseId) ||
    !HASH.test(input.runtimePackSha256) ||
    input.assetPath.length > 84 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/.test(input.assetPath)
  )
    return null
  try {
    // Public slug resolution is the only cross-tenant step; all subsequent reads
    // require the resolved exact tenant/venue and current native release.
    return await withTenantIsolationBypass(async () => {
      const client = dependencies.client ?? db
      const venue = await client.venue.findFirst({
        where: { slug: input.venueSlug, isActive: true },
        select: { id: true, tenantId: true },
      })
      if (!venue) return null
      const allowed = await (dependencies.rateLimit ?? checkRateLimit)(
        `ratelimit:custom-character-assets:${venue.tenantId}:${venue.id}`,
        4096,
        60,
      )
      if (!allowed) return null
      const scope = { tenantId: venue.tenantId, venueId: venue.id, venueSlug: input.venueSlug }
      const selected = await authority(scope, dependencies)
      if (
        !selected ||
        selected.snapshot.releaseId !== input.releaseId ||
        selected.evidence.binding.runtimePackSha256 !== input.runtimePackSha256
      )
        return null
      if (
        !selected.evidence.runtimePack.assets.some((item) => `${item.id}.png` === input.assetPath)
      )
        return null
      const value = await verifiedBundles({ ...scope, ...selected.evidence }, dependencies)
      const asset = value.pack.assets.find((item) => `${item.id}.png` === input.assetPath)
      if (!asset) return null
      const rendered = await rasterAsset(value.artifact, asset, 5)
      if (!(await stillCurrent(scope, selected, dependencies))) return null
      return { bytes: rendered.bytes, mediaType: 'image/png' as const }
    })
  } catch {
    return null
  }
}
