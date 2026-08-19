import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHARACTER_STATES = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'success',
  'processing',
  'uploadReceiving',
  'uploadComplete',
  'question',
  'handoff',
  'error',
  'sleeping',
  'minimized',
]

const PRESENTATION_CONTEXTS = new Set([
  'client-assistant',
  'venue-text-chat',
  'venue-voice-chat',
  'marketing',
])
const RENDERERS = new Set(['layered-svg-v1', 'static-image-v1'])
const MEDIA_EXTENSIONS = new Map([
  ['image/svg+xml', '.svg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
])
const FILE_BUDGET_BYTES = 512 * 1024
const PACK_BUDGET_BYTES = 2 * 1024 * 1024
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const SHA_256 = /^[a-f0-9]{64}$/

export const CHARACTER_PACK_ALLOWLIST = [
  {
    characterId: 'tochi',
    packDirectory: 'v0-development',
    expectedAssetPackId: 'tochi-dev-v0',
    expectedVersion: '0-development',
  },
]

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = path.resolve(scriptsDirectory, '..')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function safeRelativeAssetPath(assetPath) {
  return (
    typeof assetPath === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(assetPath) &&
    !assetPath.includes('\\') &&
    !assetPath.startsWith('/') &&
    !assetPath.includes('//') &&
    !assetPath.split('/').some((segment) => segment === '.' || segment === '..') &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(assetPath) &&
    !/\.(?:html?|m?js|cjs|wasm|exe|dll|bat|cmd|ps1|sh)$/i.test(assetPath)
  )
}

function assertCoordinate(point, canvas, label) {
  assert(point && Number.isFinite(point.x) && Number.isFinite(point.y), `${label} is invalid`)
  assert(point.x >= 0 && point.y >= 0, `${label} cannot be negative`)
  assert(point.x <= canvas.width && point.y <= canvas.height, `${label} is outside the canvas`)
}

function assertNoFallbackCycle(fallbacks) {
  for (const state of CHARACTER_STATES) {
    const visited = new Set()
    let current = state
    while (fallbacks[current]) {
      if (visited.has(current)) throw new Error(`Character fallback cycle includes ${current}`)
      visited.add(current)
      current = fallbacks[current]
    }
  }
}

async function sha256(filePath) {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

function verifySvgSource(source, assetPath) {
  assert(!/<script\b/i.test(source), `${assetPath} contains script content`)
  assert(!/<foreignObject\b/i.test(source), `${assetPath} contains foreignObject content`)
  assert(!/\son[a-z]+\s*=/i.test(source), `${assetPath} contains an event handler`)
  assert(
    !/(?:href|src)\s*=\s*["'](?:https?:|data:|javascript:|\/\/)/i.test(source),
    `${assetPath} contains an external or executable reference`,
  )
  assert(!/<!ENTITY\b/i.test(source), `${assetPath} contains an entity declaration`)
}

export async function verifyCharacterPack(root, pack) {
  const packRoot = path.join(root, 'assets', 'characters', pack.characterId, pack.packDirectory)
  const definitionPath = path.join(
    root,
    'assets',
    'characters',
    pack.characterId,
    'definition.json',
  )
  const manifestPath = path.join(packRoot, 'manifest.json')
  const definition = JSON.parse(await readFile(definitionPath, 'utf8'))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  assert(definition.schemaVersion === 1, 'Character definition schemaVersion must be 1')
  assert(definition.id === pack.characterId, 'Character definition id does not match its directory')
  assert(IDENTIFIER.test(definition.id), 'Character definition id is invalid')
  assert(
    IDENTIFIER.test(definition.defaultAssetPackId),
    'Character default asset pack id is invalid',
  )
  assert(
    Array.isArray(definition.supportedContexts) && definition.supportedContexts.length > 0,
    'Character definition needs contexts',
  )
  for (const context of definition.supportedContexts) {
    assert(PRESENTATION_CONTEXTS.has(context), `Unknown definition context: ${context}`)
  }

  assert(manifest.schemaVersion === 1, 'Character manifest schemaVersion must be 1')
  assert(manifest.characterId === definition.id, 'Manifest characterId does not match definition')
  assert(
    manifest.assetPackId === pack.expectedAssetPackId,
    'Manifest assetPackId is not allowlisted',
  )
  assert(manifest.version === pack.expectedVersion, 'Manifest version is not allowlisted')
  assert(IDENTIFIER.test(manifest.assetPackId), 'Manifest assetPackId is invalid')
  assert(VERSION_IDENTIFIER.test(manifest.version), 'Manifest version is invalid')
  assert(RENDERERS.has(manifest.renderer), `Unknown renderer: ${manifest.renderer}`)
  assert(
    manifest.publicBasePath === `/characters/${pack.characterId}/${pack.packDirectory}`,
    'Manifest publicBasePath does not match its immutable pack directory',
  )
  assert(
    !(manifest.artStatus === 'placeholder' && manifest.publishable),
    'Placeholder character packs cannot be publishable',
  )
  assert(
    !manifest.publishable || manifest.artStatus === 'approved',
    'Only approved character packs can be publishable',
  )

  assert(
    Array.isArray(manifest.assets) && manifest.assets.length > 0,
    'Manifest assets are required',
  )
  const assetIds = new Set()
  const allowedFiles = new Set(['manifest.json'])
  let totalBytes = 0
  for (const asset of manifest.assets) {
    assert(IDENTIFIER.test(asset.id), `Invalid asset id: ${asset.id}`)
    assert(!assetIds.has(asset.id), `Duplicate asset id: ${asset.id}`)
    assetIds.add(asset.id)
    assert(safeRelativeAssetPath(asset.path), `Unsafe character asset path: ${asset.path}`)
    assert(MEDIA_EXTENSIONS.has(asset.mediaType), `Unknown media type: ${asset.mediaType}`)
    assert(
      path.extname(asset.path).toLowerCase() === MEDIA_EXTENSIONS.get(asset.mediaType),
      `Media type does not match ${asset.path}`,
    )
    assert(
      Number.isInteger(asset.width) && asset.width > 0 && asset.width <= 4096,
      `Invalid width for ${asset.id}`,
    )
    assert(
      Number.isInteger(asset.height) && asset.height > 0 && asset.height <= 4096,
      `Invalid height for ${asset.id}`,
    )
    assert(
      Number.isInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= FILE_BUDGET_BYTES,
      `Invalid byte budget for ${asset.id}`,
    )
    assert(SHA_256.test(asset.sha256), `Missing or invalid SHA-256 for ${asset.id}`)

    const assetPath = path.resolve(packRoot, asset.path)
    assert(
      assetPath.startsWith(`${path.resolve(packRoot)}${path.sep}`),
      `Asset escaped pack root: ${asset.path}`,
    )
    const metadata = await stat(assetPath)
    assert(metadata.isFile(), `Character asset is not a file: ${asset.path}`)
    assert(metadata.size === asset.bytes, `Byte size mismatch for ${asset.path}`)
    assert((await sha256(assetPath)) === asset.sha256, `SHA-256 mismatch for ${asset.path}`)
    if (asset.mediaType === 'image/svg+xml') {
      verifySvgSource(await readFile(assetPath, 'utf8'), asset.path)
    }
    allowedFiles.add(asset.path)
    totalBytes += asset.bytes
  }
  assert(totalBytes <= PACK_BUDGET_BYTES, 'Character pack exceeds the initial byte budget')

  for (const assetId of [
    manifest.thumbnailAssetId,
    manifest.selectionPreviewAssetId,
    manifest.staticFallbackAssetId,
    manifest.reducedMotionFallbackAssetId,
    ...Object.values(manifest.layers ?? {}),
    ...Object.values(manifest.states ?? {}).map((mapping) => mapping.staticAssetId),
  ].filter(Boolean)) {
    assert(assetIds.has(assetId), `Manifest references missing asset: ${assetId}`)
  }
  assert(manifest.staticFallbackAssetId, 'Manifest static fallback is required')
  assert(manifest.reducedMotionFallbackAssetId, 'Manifest reduced-motion fallback is required')
  assert(
    manifest.renderer !== 'layered-svg-v1' || manifest.layers?.body,
    'Layered SVG pack requires a body layer',
  )

  const stateNames = Object.keys(manifest.states ?? {})
  const fallbackNames = Object.keys(manifest.stateFallbacks ?? {})
  for (const state of [
    ...stateNames,
    ...fallbackNames,
    ...Object.values(manifest.stateFallbacks ?? {}),
  ]) {
    assert(CHARACTER_STATES.includes(state), `Unknown character state: ${state}`)
  }
  assertNoFallbackCycle(manifest.stateFallbacks ?? {})
  for (const mapping of Object.values(manifest.states ?? {})) {
    assert(mapping && IDENTIFIER.test(mapping.variant), 'Character state variant is invalid')
  }
  for (const context of manifest.supportedContexts ?? []) {
    assert(PRESENTATION_CONTEXTS.has(context), `Unknown manifest context: ${context}`)
  }

  const canvas = manifest.canvas
  assert(
    canvas && Number.isInteger(canvas.width) && canvas.width > 0 && canvas.width <= 4096,
    'Canvas width is invalid',
  )
  assert(
    canvas && Number.isInteger(canvas.height) && canvas.height > 0 && canvas.height <= 4096,
    'Canvas height is invalid',
  )
  const bounds = manifest.safeBounds
  assert(
    bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0,
    'Safe bounds are invalid',
  )
  assert(
    bounds.x + bounds.width <= canvas.width && bounds.y + bounds.height <= canvas.height,
    'Safe bounds exceed canvas',
  )
  assertCoordinate(manifest.origin, canvas, 'origin')
  assertCoordinate(manifest.anchors?.lookAt, canvas, 'lookAt anchor')
  assertCoordinate(manifest.anchors?.embers, canvas, 'embers anchor')

  const directoryFiles = await readdir(packRoot, { withFileTypes: true })
  for (const entry of directoryFiles) {
    assert(entry.isFile(), `Character packs cannot contain nested directories: ${entry.name}`)
    assert(allowedFiles.has(entry.name), `Unreferenced character pack file: ${entry.name}`)
  }

  return { definition, manifest, packRoot, files: [...allowedFiles].sort() }
}

export async function verifyCharacterAssets(root = repositoryRoot) {
  const definitions = new Map()
  const packVersions = new Set()
  const verified = []
  for (const pack of CHARACTER_PACK_ALLOWLIST) {
    const packVersion = `${pack.expectedAssetPackId}@${pack.expectedVersion}`
    assert(!packVersions.has(packVersion), `Duplicate character pack version: ${packVersion}`)
    packVersions.add(packVersion)
    const candidate = await verifyCharacterPack(root, pack)
    const existingDefinition = definitions.get(candidate.definition.id)
    if (existingDefinition) {
      assert(
        JSON.stringify(existingDefinition) === JSON.stringify(candidate.definition),
        `Character definition changed between packs: ${candidate.definition.id}`,
      )
    } else {
      definitions.set(candidate.definition.id, candidate.definition)
    }
    verified.push(candidate)
  }
  for (const [characterId, definition] of definitions) {
    assert(
      verified.some(
        ({ manifest }) =>
          manifest.characterId === characterId &&
          manifest.assetPackId === definition.defaultAssetPackId,
      ),
      `Default asset pack is not allowlisted for ${characterId}: ${definition.defaultAssetPackId}`,
    )
  }
  return verified
}

const executedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (executedDirectly) {
  const verified = await verifyCharacterAssets()
  process.stdout.write(
    `${JSON.stringify({ ok: true, packs: verified.map(({ manifest }) => `${manifest.assetPackId}@${manifest.version}`) })}\n`,
  )
}
