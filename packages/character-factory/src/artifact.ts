import type {
  CharacterBundleAssetInput,
  CharacterExportArtifact,
  CharacterRuntimePack,
  CharacterRuntimePackInput,
  CharacterSpec,
  FactoryState,
  ImportedSource,
} from './types'
import { CharacterRuntimePackSchema, canonicalCharacterRuntimePack } from '@pathfinder/contracts'

const CREDENTIAL_KEYS =
  /^(access_token|api_key|apikey|auth|client_secret|credential|key|signature|sig|token)$/iu
const AZURE_SAS_KEYS = new Set([
  'sv',
  'ss',
  'srt',
  'sp',
  'se',
  'st',
  'spr',
  'sig',
  'sip',
  'si',
  'sr',
  'skoid',
  'sktid',
  'skt',
  'ske',
  'sks',
  'skv',
])

export function sanitizeImportedSource(source: ImportedSource): ImportedSource {
  const url = new URL(source.sourceUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Imported source must be an HTTP(S) URL without embedded credentials.')
  }
  const keys = [...url.searchParams.keys()]
  const lowerKeys = new Set(keys.map((key) => key.toLowerCase()))
  const azureSas = lowerKeys.has('sig') && [...AZURE_SAS_KEYS].some((key) => lowerKeys.has(key))
  for (const key of keys) {
    const lower = key.toLowerCase()
    if (
      CREDENTIAL_KEYS.test(key) ||
      lower.startsWith('x-amz-') ||
      lower.startsWith('x-goog-') ||
      (azureSas && AZURE_SAS_KEYS.has(lower))
    )
      url.searchParams.delete(key)
  }
  url.hash = ''
  return { ...source, sourceUrl: url.toString() }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const ownedBuffer = Uint8Array.from(bytes).buffer
  const digest = await globalThis.crypto.subtle.digest('SHA-256', ownedBuffer)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function createCharacterExportArtifact(
  spec: CharacterSpec,
): Promise<CharacterExportArtifact> {
  if (spec.status === 'invalid') throw new Error('Invalid characters cannot be exported.')
  const exported: CharacterSpec = {
    ...spec,
    source: sanitizeImportedSource(spec.source),
    supportedStates: [...spec.supportedStates],
    protectedTraits: [...spec.protectedTraits],
    slotMap: { ...spec.slotMap },
    status: 'exported',
  }
  const bytes = new TextEncoder().encode(stable(exported))
  return {
    mediaType: 'application/vnd.pathfinder.character+json',
    schemaVersion: 1,
    characterId: exported.characterId,
    characterVersion: exported.version,
    sha256: await sha256(bytes),
    byteLength: bytes.byteLength,
    bytes,
  }
}

export async function createCharacterBundle(
  spec: CharacterSpec,
  assets: readonly CharacterBundleAssetInput[],
  runtimePack?: CharacterRuntimePackInput,
): Promise<CharacterExportArtifact> {
  if (spec.status === 'invalid') throw new Error('Invalid characters cannot be bundled.')
  if (assets.length === 0 || assets.length > 32)
    throw new Error('A character bundle must include 1-32 assets.')
  if (assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0) > 8_000_000)
    throw new Error('Character bundle exceeds the aggregate asset limit.')
  if (new Set(assets.map((asset) => asset.path)).size !== assets.length)
    throw new Error('Character bundle asset paths must be unique.')
  const normalizedAssets = await Promise.all(
    assets.map(async (asset) => {
      if (
        !asset.path ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,499}$/u.test(asset.path) ||
        asset.path.includes('..') ||
        asset.path.includes('//') ||
        asset.path.includes(':')
      )
        throw new Error('Bundle asset paths must be safe relative paths.')
      if (asset.bytes.byteLength === 0 || asset.bytes.byteLength > 2_000_000)
        throw new Error('Bundle asset size is invalid.')
      if (asset.mediaType === 'image/svg+xml') {
        const svg = new TextDecoder().decode(asset.bytes)
        if (
          /<!DOCTYPE|<!ENTITY|<\s*(script|style|foreignObject|iframe|object|embed|image|use)\b|\bon\w+\s*=|\b(?:href|src)\s*=|@import|url\s*\(/iu.test(
            svg,
          )
        )
          throw new Error('Bundle SVG contains active or remote content.')
      }
      return {
        path: asset.path,
        mediaType: asset.mediaType,
        role: asset.role,
        ...(asset.slot ? { slot: asset.slot } : {}),
        byteLength: asset.bytes.byteLength,
        sha256: await sha256(asset.bytes),
        bytesBase64: bytesToBase64(asset.bytes),
      }
    }),
  )
  const master = normalizedAssets.find(
    (asset) => asset.path === spec.masterReference && asset.role === 'master',
  )
  if (
    !master ||
    master.sha256 !== spec.source.sha256 ||
    master.byteLength !== spec.source.byteLength ||
    master.mediaType !== spec.source.mediaType
  )
    throw new Error('Master asset bytes do not match character provenance.')
  for (const slot of Object.keys(spec.slotMap))
    if (!normalizedAssets.some((asset) => asset.role === 'slot' && asset.slot === slot))
      throw new Error(`Character slot asset is missing: ${slot}`)
  if (!normalizedAssets.some((asset) => asset.role === 'fallback'))
    throw new Error('Character bundle requires static fallback art.')
  const normalizedRuntimePack = runtimePack
    ? validateAndNormalizeRuntimePack(spec, runtimePack, normalizedAssets)
    : undefined
  const payload = {
    schemaVersion: 1,
    kind: 'pathfinder-character-bundle',
    spec: { ...spec, source: sanitizeImportedSource(spec.source) },
    assets: normalizedAssets,
    ...(normalizedRuntimePack ? { runtimePack: normalizedRuntimePack } : {}),
  }
  const bytes = new TextEncoder().encode(stable(payload))
  return {
    mediaType: 'application/vnd.pathfinder.character+json',
    schemaVersion: 1,
    characterId: spec.characterId,
    characterVersion: spec.version,
    sha256: await sha256(bytes),
    byteLength: bytes.byteLength,
    bytes,
  }
}

type NormalizedBundleAsset = {
  path: string
  mediaType: 'image/svg+xml' | 'image/png'
  role: CharacterBundleAssetInput['role']
  slot?: string
  byteLength: number
  sha256: string
  bytesBase64: string
}

function validateAndNormalizeRuntimePack(
  spec: CharacterSpec,
  pack: CharacterRuntimePackInput,
  assets: readonly NormalizedBundleAsset[],
): CharacterRuntimePack {
  let parsed: CharacterRuntimePack
  try {
    parsed = CharacterRuntimePackSchema.parse(pack)
  } catch {
    throw new Error('Character runtime pack format is unsupported.')
  }
  const normalized = JSON.parse(canonicalCharacterRuntimePack(parsed)) as CharacterRuntimePack
  if (normalized.characterId !== spec.characterId || normalized.characterVersion !== spec.version)
    throw new Error('Character runtime pack identity does not match the export.')
  if (normalized.sourceSha256 !== spec.source.sha256)
    throw new Error('Character runtime pack source hash does not match provenance.')
  if (normalized.family !== spec.rigFamily || normalized.capability !== 'rigid-source')
    throw new Error('Character runtime pack family or capability is unsupported.')
  if (!['morph-v1', 'compact-creature-v1', 'humanoid-v1'].includes(normalized.family))
    throw new Error('Character runtime pack requires a supported built-in family.')
  if (normalized.assets.length !== assets.length)
    throw new Error('Character runtime pack must reference every bundled asset exactly once.')
  const bundledByPath = new Map(assets.map((asset) => [asset.path, asset]))
  for (const asset of normalized.assets) {
    const bundled = bundledByPath.get(asset.path)
    if (!bundled)
      throw new Error(`Character runtime pack references a missing bundled asset: ${asset.path}`)
    if (
      asset.mediaType !== bundled.mediaType ||
      asset.bytes !== bundled.byteLength ||
      asset.sha256 !== bundled.sha256
    )
      throw new Error(`Character runtime pack asset does not match bundled bytes: ${asset.id}`)
    const dimensions = imageDimensions(base64ToBytes(bundled.bytesBase64), bundled.mediaType)
    if (!dimensions || dimensions.width !== asset.width || dimensions.height !== asset.height)
      throw new Error(`Character runtime pack dimensions do not match asset bytes: ${asset.id}`)
  }
  const byId = new Map(normalized.assets.map((asset) => [asset.id, asset]))
  const sourceAsset = byId.get(normalized.sourceAssetId)
  if (!sourceAsset || sourceAsset.path !== spec.masterReference || sourceAsset.sha256 !== spec.source.sha256)
    throw new Error('Character runtime pack source asset does not match provenance.')
  for (const fallbackId of [normalized.staticFallbackAssetId, normalized.reducedMotionFallbackAssetId])
    if (!byId.has(fallbackId) || !assets.some((asset) => asset.path === byId.get(fallbackId)?.path && asset.role === 'fallback'))
      throw new Error('Character runtime pack fallback asset is missing.')
  for (const state of normalized.supportedStates) {
    if (!FACTORY_STATE_SET.has(state) || !spec.supportedStates.includes(state as FactoryState))
      throw new Error(`Character runtime pack state is unsupported: ${state}`)
  }
  return normalized
}

const FACTORY_STATE_SET = new Set<string>([
  'idle', 'attention', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'success', 'error', 'reaction',
])

function imageDimensions(bytes: Uint8Array, mediaType: 'image/svg+xml' | 'image/png') {
  if (mediaType === 'image/png') {
    if (
      bytes.byteLength < 45 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    )
      return undefined
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(8) !== 13 || textChunk(bytes, 12) !== 'IHDR') return undefined
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    let offset = 8
    let foundEnd = false
    while (offset + 12 <= bytes.byteLength) {
      const length = view.getUint32(offset)
      const chunkEnd = offset + 12 + length
      if (chunkEnd > bytes.byteLength) return undefined
      const type = textChunk(bytes, offset + 4)
      if (!type) return undefined
      if (type === 'IEND') {
        if (length !== 0 || chunkEnd !== bytes.byteLength) return undefined
        foundEnd = true
        break
      }
      offset = chunkEnd
    }
    if (!foundEnd || width < 1 || height < 1) return undefined
    return { width, height }
  }
  const svg = new TextDecoder().decode(bytes)
  const match = /<svg\b[^>]*\bviewBox\s*=\s*["']\s*(-?(?:\d+\.?\d*|\.\d+))\s+(-?(?:\d+\.?\d*|\.\d+))\s+(\d+(?:\.\d*)?|\.\d+)\s+(\d+(?:\.\d*)?|\.\d+)\s*["']/iu.exec(svg)
  if (!match) return undefined
  const width = Number(match[3])
  const height = Number(match[4])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return undefined
  return { width, height }
}

function textChunk(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.byteLength) return undefined
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const value of bytes) binary += String.fromCharCode(value)
  return globalThis.btoa(binary)
}

export async function readCharacterExportArtifact(
  artifact: CharacterExportArtifact,
): Promise<CharacterSpec> {
  if (
    artifact.byteLength !== artifact.bytes.byteLength ||
    (await sha256(artifact.bytes)) !== artifact.sha256
  ) {
    throw new Error('Character export artifact integrity check failed.')
  }
  const decoded = JSON.parse(new TextDecoder().decode(artifact.bytes)) as
    | CharacterSpec
    | {
        kind?: string
        spec?: CharacterSpec
        runtimePack?: CharacterRuntimePackInput
        assets?: Array<{
          path: string
          mediaType: string
          role: CharacterBundleAssetInput['role']
          slot?: string
          byteLength: number
          sha256: string
          bytesBase64: string
        }>
      }
  if ('kind' in decoded && decoded.kind === 'pathfinder-character-bundle') {
    if (!decoded.spec || !decoded.assets?.length)
      throw new Error('Character bundle payload is incomplete.')
    if (
      decoded.spec.characterId !== artifact.characterId ||
      decoded.spec.version !== artifact.characterVersion
    )
      throw new Error('Character bundle metadata does not match its payload.')
    for (const asset of decoded.assets) {
      const bytes = base64ToBytes(asset.bytesBase64)
      if (bytes.byteLength !== asset.byteLength || (await sha256(bytes)) !== asset.sha256)
        throw new Error('Character bundle asset integrity check failed.')
    }
    const rebuilt = await createCharacterBundle(
      decoded.spec,
      decoded.assets.map((asset) => ({
        path: asset.path,
        mediaType: asset.mediaType as 'image/svg+xml' | 'image/png',
        role: asset.role,
        ...(asset.slot ? { slot: asset.slot } : {}),
        bytes: base64ToBytes(asset.bytesBase64),
      })),
      decoded.runtimePack,
    )
    if (rebuilt.sha256 !== artifact.sha256)
      throw new Error('Character bundle reconstruction failed.')
    return decoded.spec
  }
  const value = decoded as CharacterSpec
  if (
    value.characterId !== artifact.characterId ||
    value.version !== artifact.characterVersion ||
    value.status !== 'exported'
  ) {
    throw new Error('Character export artifact metadata does not match its payload.')
  }
  return value
}

export async function readCharacterBundle(
  artifact: CharacterExportArtifact,
): Promise<CharacterSpec> {
  if (
    artifact.byteLength !== artifact.bytes.byteLength ||
    (await sha256(artifact.bytes)) !== artifact.sha256
  )
    throw new Error('Character export artifact integrity check failed.')
  const decoded = JSON.parse(new TextDecoder().decode(artifact.bytes)) as { kind?: unknown }
  if (decoded.kind !== 'pathfinder-character-bundle')
    throw new Error('Stored character artifact must be a portable character bundle.')
  return readCharacterExportArtifact(artifact)
}

/**
 * Returns only an explicitly prepared pack. A v1 spec or legacy bundle remains
 * readable through readCharacterExportArtifact but is never animation-publishable.
 */
export async function readCharacterRuntimePack(
  artifact: CharacterExportArtifact,
): Promise<{ spec: CharacterSpec; runtimePack: CharacterRuntimePack }> {
  const spec = await readCharacterBundle(artifact)
  const decoded = JSON.parse(new TextDecoder().decode(artifact.bytes)) as {
    runtimePack?: CharacterRuntimePackInput
  }
  if (!decoded.runtimePack)
    throw new Error('Legacy character exports are not animation-publishable.')
  // Rebuild validation in readCharacterExportArtifact has already bound every
  // reference to bundled bytes. Return the canonical verified declaration only.
  return {
    spec,
    runtimePack: JSON.parse(
      canonicalCharacterRuntimePack(CharacterRuntimePackSchema.parse(decoded.runtimePack)),
    ) as CharacterRuntimePack,
  }
}

/**
 * Resolves one runtime-pack allowlisted asset after the complete bundle has
 * been verified. Callers never need to parse the private editable bundle.
 */
export async function readCharacterRuntimeAsset(
  artifact: CharacterExportArtifact,
  input: { assetId: string },
): Promise<{
  spec: CharacterSpec
  runtimePack: CharacterRuntimePack
  asset: CharacterRuntimePack['assets'][number]
  bytes: Uint8Array
}> {
  const { spec, runtimePack } = await readCharacterRuntimePack(artifact)
  const asset = runtimePack.assets.find((candidate) => candidate.id === input.assetId)
  if (!asset) throw new Error('Character runtime pack asset is not allowlisted.')
  const decoded = JSON.parse(new TextDecoder().decode(artifact.bytes)) as {
    assets?: NormalizedBundleAsset[]
  }
  const bundled = decoded.assets?.find((candidate) => candidate.path === asset.path)
  if (!bundled) throw new Error('Character runtime pack asset is missing from the verified bundle.')
  const bytes = base64ToBytes(bundled.bytesBase64)
  const dimensions = imageDimensions(bytes, bundled.mediaType)
  if (
    bundled.mediaType !== asset.mediaType ||
    bundled.byteLength !== asset.bytes ||
    bundled.sha256 !== asset.sha256 ||
    bytes.byteLength !== asset.bytes ||
    (await sha256(bytes)) !== asset.sha256 ||
    !dimensions ||
    dimensions.width !== asset.width ||
    dimensions.height !== asset.height
  )
    throw new Error('Character runtime pack asset failed exact byte verification.')
  return { spec, runtimePack, asset, bytes }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = globalThis.atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function fingerprintFactoryRequest(request: unknown): string {
  return stable(request)
}
