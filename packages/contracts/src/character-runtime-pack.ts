import { z } from 'zod'

export const CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES = 1 * 1024 * 1024
export const CHARACTER_RUNTIME_PACK_TOTAL_MAX_BYTES = 2 * 1024 * 1024

// This is a prepared renderer input, not approval or publication authority.
// The exporter verifies dimensions and digests against the actual embedded bytes.
const Id = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80)
const Dimension = z.number().int().min(1).max(4096)
const Coordinate = z.number().finite().min(0).max(4096)
const Point = z.object({ x: Coordinate, y: Coordinate }).strict()
const Canvas = z.object({ width: Dimension, height: Dimension }).strict()
export const RuntimePackStateSchema = z.enum([
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
])
export const RuntimePackContextSchema = z.enum([
  'client-assistant',
  'venue-text-chat',
  'venue-voice-chat',
  'marketing',
])
export const RuntimePackAssetSchema = z
  .object({
    id: Id,
    path: z
      .string()
      .max(240)
      .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:svg|png)$/),
    mediaType: z.enum(['image/svg+xml', 'image/png']),
    width: Dimension,
    height: Dimension,
    bytes: z.number().int().min(1).max(CHARACTER_RUNTIME_PACK_ASSET_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

const RuntimePackBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    renderer: z.literal('family-rig-v1'),
    characterId: Id,
    characterVersion: z.number().int().positive(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    family: z.enum(['morph-v1', 'compact-creature-v1', 'humanoid-v1']),
    // The unchanged family adapter composes normalized whole-image layers.
    capability: z.literal('rigid-source'),
    assets: z.array(RuntimePackAssetSchema).min(1).max(32),
    canvas: Canvas,
    safeBounds: Point.extend({ width: Dimension, height: Dimension }).strict(),
    origin: Point,
    anchors: z.object({ lookAt: Point, embers: Point }).strict(),
    sourceAssetId: Id,
    staticFallbackAssetId: Id,
    reducedMotionFallbackAssetId: Id,
    layers: z
      .array(
        z
          .object({
            role: z.enum(['body', 'face', 'wing', 'head', 'torso', 'arm', 'leg', 'eyes', 'shadow']),
            assetId: Id,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    supportedStates: z.array(RuntimePackStateSchema).min(1).max(14),
    stateFallbacks: z.record(RuntimePackStateSchema, RuntimePackStateSchema),
    supportedContexts: z.array(RuntimePackContextSchema).min(1).max(4),
  })
  .strict()

function validatePack(
  pack: Omit<z.infer<typeof RuntimePackBaseSchema>, 'sourceSha256' | 'characterVersion'>,
  context: z.RefinementCtx,
) {
  const reject = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message })
  const assets = new Map(pack.assets.map((asset) => [asset.id, asset]))
  if (
    assets.size !== pack.assets.length ||
    new Set(pack.assets.map((a) => a.path)).size !== pack.assets.length
  )
    reject('Asset identities and paths must be unique.')
  if (
    pack.assets.reduce((total, asset) => total + asset.bytes, 0) >
    CHARACTER_RUNTIME_PACK_TOTAL_MAX_BYTES
  )
    reject('Runtime pack exceeds the initial byte budget.')
  for (const asset of pack.assets) {
    if (!asset.path.endsWith(asset.mediaType === 'image/png' ? '.png' : '.svg'))
      reject('Asset media type and extension differ.')
    if (asset.width !== pack.canvas.width || asset.height !== pack.canvas.height)
      reject('Family assets must use the declared normalized full canvas.')
  }
  for (const id of [
    pack.sourceAssetId,
    pack.staticFallbackAssetId,
    pack.reducedMotionFallbackAssetId,
    ...pack.layers.map((layer) => layer.assetId),
  ]) {
    if (!assets.has(id)) reject('Runtime pack references an absent asset.')
  }
  if (new Set(pack.layers.map((layer) => layer.assetId)).size !== pack.layers.length)
    reject('A layer asset cannot be rendered twice.')
  if (
    pack.safeBounds.x + pack.safeBounds.width > pack.canvas.width ||
    pack.safeBounds.y + pack.safeBounds.height > pack.canvas.height
  )
    reject('Safe bounds exceed the canvas.')
  for (const point of [pack.origin, pack.anchors.lookAt, pack.anchors.embers]) {
    if (point.x > pack.canvas.width || point.y > pack.canvas.height)
      reject('Anchor or origin exceeds the canvas.')
  }
  if (
    new Set(pack.supportedStates).size !== pack.supportedStates.length ||
    !pack.supportedStates.includes('idle')
  )
    reject('Supported states must be unique and include idle.')
  if (new Set(pack.supportedContexts).size !== pack.supportedContexts.length)
    reject('Contexts must be unique.')
  for (const state of RuntimePackStateSchema.options) {
    const visited = new Set<string>()
    let current: typeof state | undefined = state
    while (current && !pack.supportedStates.includes(current)) {
      if (visited.has(current)) {
        reject('State fallback cycle.')
        break
      }
      visited.add(current)
      current = pack.stateFallbacks[current]
    }
    if (!current) reject('Every unsupported state requires a fallback to a supported state.')
    if (pack.supportedStates.includes(state) && pack.stateFallbacks[state])
      reject('Supported states cannot also redirect.')
  }
}
export const CharacterRuntimePackSchema = RuntimePackBaseSchema.superRefine(validatePack)
const PublicFamilyRigBaseSchema = RuntimePackBaseSchema.pick({
  schemaVersion: true,
  renderer: true,
  characterId: true,
  family: true,
  capability: true,
  assets: true,
  canvas: true,
  safeBounds: true,
  origin: true,
  anchors: true,
  sourceAssetId: true,
  staticFallbackAssetId: true,
  reducedMotionFallbackAssetId: true,
  layers: true,
  supportedStates: true,
  stateFallbacks: true,
  supportedContexts: true,
}).strict()
export const PublicFamilyRigSchema = PublicFamilyRigBaseSchema.superRefine(validatePack)
export type PublicFamilyRig = z.infer<typeof PublicFamilyRigSchema>
export function createPublicFamilyRig(input: CharacterRuntimePack): PublicFamilyRig {
  const privatePack = CharacterRuntimePackSchema.parse(input)
  const publicFields = PublicFamilyRigBaseSchema.strip().parse(privatePack)
  return PublicFamilyRigSchema.parse(publicFields)
}
export type CharacterRuntimePack = z.infer<typeof CharacterRuntimePackSchema>

/** Object keys are canonical; array order (especially drawing order) is significant. */
export function canonicalCharacterRuntimePack(input: CharacterRuntimePack): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([key, item]) => [key, canonical(item)]),
      )
    return value
  }
  return JSON.stringify(canonical(CharacterRuntimePackSchema.parse(input)))
}
