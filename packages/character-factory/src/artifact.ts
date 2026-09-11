import type {
  CharacterBundleAssetInput,
  CharacterExportArtifact,
  CharacterSpec,
  ImportedSource,
} from './types'

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
  const payload = {
    schemaVersion: 1,
    kind: 'pathfinder-character-bundle',
    spec: { ...spec, source: sanitizeImportedSource(spec.source) },
    assets: normalizedAssets,
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

function base64ToBytes(value: string): Uint8Array {
  const binary = globalThis.atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function fingerprintFactoryRequest(request: unknown): string {
  return stable(request)
}
