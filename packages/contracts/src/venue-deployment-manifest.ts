import { z } from 'zod'

import { TonePresetId } from './tone-presets'
import { CapabilityId, VenueArchetypeId, VenuePresetId } from './venue-configuration'

export const VENUE_DEPLOYMENT_MANIFEST_VERSION = 2 as const
export const VENUE_DEPLOYMENT_MAX_MODULES = 1_000
export const VENUE_DEPLOYMENT_MAX_ASSETS = 500
export const VENUE_DEPLOYMENT_MAX_OPERATIONS = 1_000

const Hash = z.string().regex(/^[a-f0-9]{64}$/u)
const unsafeLocator =
  /(?:[?&](?:token|signature|sig|key|secret|credential|auth)=)|(?:bearer\s)|(?:-----BEGIN)|(?:[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/iu
export const EvidenceLocator = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => {
    if (unsafeLocator.test(value)) return false
    if (/^[a-z][a-z0-9+.-]*:/iu.test(value) && !/^https:\/\//iu.test(value)) {
      return /^(?:evidence|interview|onboarding|intake-upload):[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(
        value,
      )
    }
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }, 'Evidence locators must be safe HTTPS references without credentials/query/fragment or allowlisted internal references.')
const StableId = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u)
const AssetId = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^asset_[a-zA-Z0-9._:-]+$/u)
const EvidenceReference = z
  .object({
    evidenceId: StableId,
    sourceId: StableId,
    locator: EvidenceLocator,
    capturedAt: z.string().datetime({ offset: true }),
    excerptHash: Hash.optional(),
  })
  .strict()

const moduleEnvelope = {
  id: StableId,
  version: z.number().int().positive(),
  audience: z.enum(['PUBLIC', 'CLIENT', 'OPERATOR']),
  evidence: z.array(EvidenceReference).max(100).default([]),
  assetIds: z.array(AssetId).max(50).default([]),
} as const

const PlaceModule = z
  .object({
    ...moduleEnvelope,
    kind: z.literal('PLACE'),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    parentId: StableId.optional(),
    accessibility: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  })
  .strict()
const ItemModule = z
  .object({
    ...moduleEnvelope,
    kind: z.literal('ITEM'),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    placeId: StableId.optional(),
    itemType: z.string().trim().min(1).max(100),
  })
  .strict()
const KnowledgeModule = z
  .object({
    ...moduleEnvelope,
    kind: z.literal('KNOWLEDGE'),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(50_000),
    topics: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  })
  .strict()
const ServiceModule = z
  .object({
    ...moduleEnvelope,
    kind: z.literal('SERVICE'),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    availability: z.string().trim().max(2_000).optional(),
    placeId: StableId.optional(),
  })
  .strict()
const PolicyModule = z
  .object({
    ...moduleEnvelope,
    kind: z.literal('POLICY'),
    title: z.string().trim().min(1).max(200),
    rule: z.string().trim().min(1).max(20_000),
    appliesTo: z.array(StableId).max(100).default([]),
  })
  .strict()
const EventModule = z
  .object({
    ...moduleEnvelope,
    kind: z.literal('EVENT'),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000).optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional(),
    placeId: StableId.optional(),
  })
  .strict()
const OperationalFactModule = z
  .object({
    ...moduleEnvelope,
    kind: z.literal('OPERATIONAL_FACT'),
    label: z.string().trim().min(1).max(200),
    value: z.string().trim().min(1).max(5_000),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    effectiveUntil: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
const RelationshipModule = z
  .object({
    ...moduleEnvelope,
    kind: z.literal('RELATIONSHIP'),
    fromId: StableId,
    toId: StableId,
    relationshipType: z.string().trim().min(1).max(100),
  })
  .strict()
  .refine((value) => value.fromId !== value.toId, {
    path: ['toId'],
    message: 'A relationship must connect different stable IDs.',
  })

export const DeploymentContentModule = z.union([
  PlaceModule,
  ItemModule,
  KnowledgeModule,
  ServiceModule,
  PolicyModule,
  EventModule,
  OperationalFactModule,
  RelationshipModule,
])
export type DeploymentContentModule = z.infer<typeof DeploymentContentModule>
export const DeploymentContentModuleKind = z.enum([
  'PLACE',
  'ITEM',
  'KNOWLEDGE',
  'SERVICE',
  'POLICY',
  'EVENT',
  'OPERATIONAL_FACT',
  'RELATIONSHIP',
])

export const DeploymentAsset = z
  .object({
    assetId: AssetId,
    sha256: Hash,
    mediaType: z
      .string()
      .trim()
      .min(1)
      .max(127)
      .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u),
    byteSize: z.number().int().nonnegative().max(5_000_000_000),
    immutableRef: z.string().regex(/^asset:sha256\/[a-f0-9]{64}$/u),
    filename: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((asset) => !asset.immutableRef.includes('://'), {
    path: ['immutableRef'],
    message: 'Assets must use immutable asset references, not URLs.',
  })
  .refine((asset) => asset.immutableRef === `asset:sha256/${asset.sha256.toLowerCase()}`, {
    path: ['immutableRef'],
    message: 'The immutable asset reference must agree with the declared SHA-256 hash.',
  })
export type DeploymentAsset = z.infer<typeof DeploymentAsset>

export const DeploymentIdentity = z
  .object({
    venueStableId: StableId,
    name: z.string().trim().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().trim().max(10_000).optional(),
    archetype: VenueArchetypeId,
  })
  .strict()
export const DeploymentBranding = z
  .object({
    themeId: z.enum(['default', 'forest', 'sunset', 'midnight', 'rose', 'dark']),
    accentColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/u)
      .optional(),
    fontId: z.enum(['jakarta', 'inter', 'poppins', 'spaceGrotesk', 'dmSans', 'playfair']),
    logoAssetId: AssetId.optional(),
    bannerAssetId: AssetId.optional(),
  })
  .strict()

const ModelReference = z
  .object({
    purpose: z.enum(['CHAT', 'EMBEDDING', 'EVALUATION', 'CLASSIFICATION']),
    provider: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9._-]+$/u),
    modelRef: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u),
    configVersion: z.number().int().positive(),
  })
  .strict()
  .refine((value) => !value.modelRef.includes('://'), {
    path: ['modelRef'],
    message: 'Model references cannot be URLs.',
  })
export const DeploymentAiConfiguration = z
  .object({
    guideName: z.string().trim().min(1).max(80).optional(),
    tone: z.object({ preset: TonePresetId, behaviorVersion: z.number().int().positive() }).strict(),
    modelReferences: z.array(ModelReference).max(20),
  })
  .strict()

const EffectiveConfigurationProvenance = z
  .object({
    key: z.string().trim().min(1).max(200),
    sourceLayer: z.enum([
      'platform-default',
      'capability-default',
      'preset-default',
      'client-override',
      'venue-override',
      'experience-override',
    ]),
    sourceId: StableId.optional(),
  })
  .strict()
export const DeploymentCapabilities = z
  .object({
    preset: VenuePresetId.optional(),
    enabled: z.array(CapabilityId).max(100),
    effectiveConfigurationProvenance: z.array(EffectiveConfigurationProvenance).max(500),
  })
  .strict()

export const DeploymentEvaluationReferences = z
  .object({
    evaluationRunId: StableId,
    readinessAssessmentId: StableId,
    readiness: z.enum(['READY', 'READY_WITH_WARNINGS', 'NOT_READY']),
    evaluatedManifestHash: Hash.optional(),
  })
  .strict()
export const DeploymentProvenance = z
  .object({
    sourceIds: z.array(StableId).min(1).max(500),
    evidenceIds: z.array(StableId).max(5_000),
    createdAt: z.string().datetime({ offset: true }),
    createdBy: z
      .object({ kind: z.enum(['CLIENT', 'OPERATOR', 'SYSTEM']), actorRef: StableId.optional() })
      .strict(),
    generatorRef: StableId.optional(),
  })
  .strict()

const manifestEnvelope = {
  schemaVersion: z.literal(VENUE_DEPLOYMENT_MANIFEST_VERSION),
  manifestId: z.string().uuid(),
  venueRef: StableId,
  idempotencyKey: z.string().uuid(),
  provenance: DeploymentProvenance,
} as const

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: z.RefinementCtx,
  path: string,
) {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const itemKey = key(value)
    if (seen.has(itemKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index],
        message: `Duplicate stable key ${itemKey}.`,
      })
    }
    seen.add(itemKey)
  })
}

export const VenueDeploymentFullManifest = z
  .object({
    ...manifestEnvelope,
    packageType: z.literal('FULL'),
    identity: DeploymentIdentity,
    branding: DeploymentBranding,
    aiConfiguration: DeploymentAiConfiguration,
    capabilities: DeploymentCapabilities,
    contentModules: z.array(DeploymentContentModule).max(VENUE_DEPLOYMENT_MAX_MODULES),
    assets: z.array(DeploymentAsset).max(VENUE_DEPLOYMENT_MAX_ASSETS),
    evaluation: DeploymentEvaluationReferences,
  })
  .strict()
  .superRefine((manifest, context) => {
    uniqueBy(
      manifest.contentModules,
      (item) => `${item.kind}:${item.id}`,
      context,
      'contentModules',
    )
    uniqueBy(manifest.assets, (item) => item.assetId, context, 'assets')
    uniqueBy(manifest.capabilities.enabled, (item) => item, context, 'capabilities')
    uniqueBy(
      manifest.capabilities.effectiveConfigurationProvenance,
      (item) => item.key,
      context,
      'capabilities',
    )
    uniqueBy(
      manifest.aiConfiguration.modelReferences,
      (item) => item.purpose,
      context,
      'aiConfiguration',
    )
    uniqueBy(manifest.provenance.sourceIds, (item) => item, context, 'provenance')
    uniqueBy(manifest.provenance.evidenceIds, (item) => item, context, 'provenance')
    const assetIds = new Set(manifest.assets.map((asset) => asset.assetId))
    const references = [
      manifest.branding.logoAssetId,
      manifest.branding.bannerAssetId,
      ...manifest.contentModules.flatMap((item) => item.assetIds),
    ].filter((value): value is string => value !== undefined)
    references.forEach((assetId) => {
      if (!assetIds.has(assetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assets'],
          message: `Asset reference ${assetId} is not declared.`,
        })
      }
    })
  })
export type VenueDeploymentFullManifest = z.infer<typeof VenueDeploymentFullManifest>

const operationEnvelope = { operationId: z.string().uuid() } as const
const patchOperations = [
  z
    .object({ ...operationEnvelope, op: z.literal('UPSERT_IDENTITY'), value: DeploymentIdentity })
    .strict(),
  z
    .object({ ...operationEnvelope, op: z.literal('UPSERT_BRANDING'), value: DeploymentBranding })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('UPSERT_AI_CONFIGURATION'),
      value: DeploymentAiConfiguration,
    })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('SET_PRESET'),
      preset: VenuePresetId,
      provenance: EffectiveConfigurationProvenance,
    })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('SET_EFFECTIVE_CONFIG_PROVENANCE'),
      value: EffectiveConfigurationProvenance,
    })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('RETIRE_EFFECTIVE_CONFIG_PROVENANCE'),
      key: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('SET_CAPABILITY'),
      capabilityId: CapabilityId,
      enabled: z.boolean(),
      provenance: EffectiveConfigurationProvenance,
    })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('RESET_CONFIGURATION'),
      path: z.enum([
        'identity.description',
        'branding.accentColor',
        'branding.logoAssetId',
        'branding.bannerAssetId',
        'aiConfiguration.guideName',
        'aiConfiguration.tone',
        'aiConfiguration.modelReferences',
        'capabilities.preset',
      ]),
    })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('UPSERT_CONTENT_MODULE'),
      value: DeploymentContentModule,
    })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('RETIRE_CONTENT_MODULE'),
      moduleKind: DeploymentContentModuleKind,
      moduleId: StableId,
      expectedVersion: z.number().int().positive().optional(),
      reason: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('RESET_CONTENT_FIELD'),
      moduleKind: DeploymentContentModuleKind,
      moduleId: StableId,
      field: z.enum([
        'description',
        'parentId',
        'accessibility',
        'placeId',
        'topics',
        'availability',
        'appliesTo',
        'effectiveFrom',
        'effectiveUntil',
        'assetIds',
      ]),
    })
    .strict(),
  z
    .object({ ...operationEnvelope, op: z.literal('UPSERT_ASSET'), value: DeploymentAsset })
    .strict(),
  z.object({ ...operationEnvelope, op: z.literal('RETIRE_ASSET'), assetId: AssetId }).strict(),
  z
    .object({
      ...operationEnvelope,
      op: z.literal('SET_EVALUATION_REFERENCES'),
      value: DeploymentEvaluationReferences,
    })
    .strict(),
] as const

export const VenueDeploymentPatchOperation = z.discriminatedUnion('op', patchOperations)
export type VenueDeploymentPatchOperation = z.infer<typeof VenueDeploymentPatchOperation>
export const VenueDeploymentPatchManifest = z
  .object({
    ...manifestEnvelope,
    packageType: z.literal('PATCH'),
    baseManifestHash: Hash,
    operations: z.array(VenueDeploymentPatchOperation).min(1).max(VENUE_DEPLOYMENT_MAX_OPERATIONS),
  })
  .strict()
  .superRefine((manifest, context) => {
    uniqueBy(manifest.operations, (operation) => operation.operationId, context, 'operations')
  })
export type VenueDeploymentPatchManifest = z.infer<typeof VenueDeploymentPatchManifest>

export const VenueDeploymentManifest = z.union([
  VenueDeploymentFullManifest,
  VenueDeploymentPatchManifest,
])
export type VenueDeploymentManifest = z.infer<typeof VenueDeploymentManifest>

export const VenueDeploymentMaterializationSection = z.enum([
  'IDENTITY',
  'BRANDING',
  'AI_CONFIGURATION',
  'CAPABILITIES',
  'CONTENT',
  'ASSETS',
  'EVALUATION',
])
export const VenueDeploymentMaterializationIssue = z
  .object({
    severity: z.enum(['ERROR', 'WARNING']),
    code: z.string().trim().min(1).max(100),
    path: z.string().max(500),
    message: z.string().trim().min(1).max(1_000),
  })
  .strict()
export const VenueDeploymentMaterializationReport = z
  .object({
    artifactKind: z.literal('VENUE_DEPLOYMENT_MANIFEST_V2'),
    manifestHash: Hash,
    baseManifestHash: Hash.nullable(),
    status: z.enum(['MATERIALIZABLE', 'NOT_MATERIALIZABLE']),
    coverage: z
      .object({
        IDENTITY: z.enum(['COMPLETE', 'BLOCKED']),
        BRANDING: z.enum(['COMPLETE', 'BLOCKED']),
        AI_CONFIGURATION: z.enum(['COMPLETE', 'BLOCKED']),
        CAPABILITIES: z.enum(['COMPLETE', 'BLOCKED']),
        CONTENT: z.enum(['COMPLETE', 'BLOCKED']),
        ASSETS: z.enum(['COMPLETE', 'BLOCKED']),
        EVALUATION: z.enum(['COMPLETE', 'BLOCKED']),
      })
      .strict(),
    issues: z.array(VenueDeploymentMaterializationIssue).max(5_000),
    legacyPayloadHash: Hash.nullable(),
  })
  .strict()
export type VenueDeploymentMaterializationReport = z.infer<
  typeof VenueDeploymentMaterializationReport
>
type DeploymentPatchOperationInput<T = VenueDeploymentPatchOperation> = T extends unknown
  ? Omit<T, 'operationId'>
  : never

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalValue)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  }
  return value
}

export function canonicalDeploymentManifest(manifest: VenueDeploymentManifest): string {
  return JSON.stringify(canonicalValue(VenueDeploymentManifest.parse(manifest)))
}

export function canonicalDeploymentManifestHashInput(manifest: VenueDeploymentManifest): string {
  const parsed = VenueDeploymentManifest.parse(manifest)
  const hashDomain =
    parsed.packageType === 'FULL'
      ? {
          ...parsed,
          evaluation: { ...parsed.evaluation, evaluatedManifestHash: undefined },
        }
      : parsed
  return JSON.stringify(canonicalValue(hashDomain))
}

export function validateDeploymentManifest(input: unknown): VenueDeploymentManifest {
  return VenueDeploymentManifest.parse(input)
}

export function safeValidateDeploymentManifest(input: unknown) {
  return VenueDeploymentManifest.safeParse(input)
}

function utf8(value: string) {
  const bytes: number[] = []
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    if (point < 0x80) bytes.push(point)
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
    else if (point < 0x10000)
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f))
    else
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      )
  }
  return bytes
}

function rotateRight(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount))
}

/** Browser-safe synchronous SHA-256 over the canonical manifest JSON. */
export function sha256Hex(value: string): string {
  const bytes = utf8(value)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(bitLength / 0x1_0000_0000)
  const low = bitLength >>> 0
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 255)
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 255)
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0)
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4
      words[index] =
        (((bytes[position] ?? 0) << 24) |
          ((bytes[position + 1] ?? 0) << 16) |
          ((bytes[position + 2] ?? 0) << 8) |
          (bytes[position + 3] ?? 0)) >>>
        0
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15] ?? 0
      const before2 = words[index - 2] ?? 0
      const s0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3)
      const s1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10)
      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0
    state[1] = ((state[1] ?? 0) + b) >>> 0
    state[2] = ((state[2] ?? 0) + c) >>> 0
    state[3] = ((state[3] ?? 0) + d) >>> 0
    state[4] = ((state[4] ?? 0) + e) >>> 0
    state[5] = ((state[5] ?? 0) + f) >>> 0
    state[6] = ((state[6] ?? 0) + g) >>> 0
    state[7] = ((state[7] ?? 0) + h) >>> 0
  }
  return state.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('')
}

export function deploymentManifestHash(manifest: VenueDeploymentManifest): string {
  return sha256Hex(canonicalDeploymentManifestHashInput(manifest))
}

function deterministicOperationId(seed: string) {
  const value = sha256Hex(seed)
  const body = `${value.slice(0, 12)}4${value.slice(13, 16)}a${value.slice(17, 20)}${value.slice(20, 32)}`
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20)}`
}

export function diffDeploymentManifests(
  base: VenueDeploymentFullManifest,
  desired: VenueDeploymentFullManifest,
  metadata: { manifestId: string; idempotencyKey: string },
): VenueDeploymentPatchManifest {
  const before = VenueDeploymentFullManifest.parse(base)
  const after = VenueDeploymentFullManifest.parse(desired)
  if (before.venueRef !== after.venueRef)
    throw new Error('Cannot diff manifests for different venues.')
  const baseManifestHash = deploymentManifestHash(before)
  const operations: VenueDeploymentPatchOperation[] = []
  const add = (operation: DeploymentPatchOperationInput) => {
    const operationId = deterministicOperationId(
      `${baseManifestHash}:${JSON.stringify(canonicalValue(operation))}`,
    )
    operations.push({ ...operation, operationId } as VenueDeploymentPatchOperation)
  }
  if (
    JSON.stringify(canonicalValue(before.identity)) !==
    JSON.stringify(canonicalValue(after.identity))
  )
    add({ op: 'UPSERT_IDENTITY', value: after.identity })
  if (
    JSON.stringify(canonicalValue(before.branding)) !==
    JSON.stringify(canonicalValue(after.branding))
  )
    add({ op: 'UPSERT_BRANDING', value: after.branding })
  if (
    JSON.stringify(canonicalValue(before.aiConfiguration)) !==
    JSON.stringify(canonicalValue(after.aiConfiguration))
  )
    add({ op: 'UPSERT_AI_CONFIGURATION', value: after.aiConfiguration })
  if (before.capabilities.preset !== after.capabilities.preset) {
    if (after.capabilities.preset) {
      add({
        op: 'SET_PRESET',
        preset: after.capabilities.preset,
        provenance: {
          key: 'capabilities.preset',
          sourceLayer: 'preset-default',
          sourceId: after.capabilities.preset,
        },
      })
    } else add({ op: 'RESET_CONFIGURATION', path: 'capabilities.preset' })
  }
  const enabledBefore = new Set(before.capabilities.enabled)
  const enabledAfter = new Set(after.capabilities.enabled)
  for (const capabilityId of [...new Set([...enabledBefore, ...enabledAfter])].sort()) {
    if (enabledBefore.has(capabilityId) !== enabledAfter.has(capabilityId)) {
      add({
        op: 'SET_CAPABILITY',
        capabilityId,
        enabled: enabledAfter.has(capabilityId),
        provenance: after.capabilities.effectiveConfigurationProvenance.find(
          (item) => item.key === `capability.${capabilityId}`,
        ) ?? {
          key: `capability.${capabilityId}`,
          sourceLayer: 'venue-override',
          sourceId: after.identity.venueStableId,
        },
      })
    }
  }
  const beforeConfigProvenance = new Map(
    before.capabilities.effectiveConfigurationProvenance.map((item) => [item.key, item]),
  )
  for (const item of after.capabilities.effectiveConfigurationProvenance) {
    if (
      JSON.stringify(canonicalValue(beforeConfigProvenance.get(item.key))) !==
      JSON.stringify(canonicalValue(item))
    )
      add({ op: 'SET_EFFECTIVE_CONFIG_PROVENANCE', value: item })
  }
  const afterConfigKeys = new Set(
    after.capabilities.effectiveConfigurationProvenance.map((item) => item.key),
  )
  for (const key of beforeConfigProvenance.keys()) {
    if (!afterConfigKeys.has(key)) add({ op: 'RETIRE_EFFECTIVE_CONFIG_PROVENANCE', key })
  }
  const beforeModules = new Map(
    before.contentModules.map((item) => [`${item.kind}:${item.id}`, item]),
  )
  const afterModules = new Map(
    after.contentModules.map((item) => [`${item.kind}:${item.id}`, item]),
  )
  for (const [key, module] of [...afterModules].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      JSON.stringify(canonicalValue(beforeModules.get(key))) !==
      JSON.stringify(canonicalValue(module))
    )
      add({ op: 'UPSERT_CONTENT_MODULE', value: module })
  }
  for (const [key, module] of [...beforeModules].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!afterModules.has(key))
      add({
        op: 'RETIRE_CONTENT_MODULE',
        moduleKind: module.kind,
        moduleId: module.id,
        expectedVersion: module.version,
      })
  }
  const beforeAssets = new Map(before.assets.map((asset) => [asset.assetId, asset]))
  const afterAssets = new Map(after.assets.map((asset) => [asset.assetId, asset]))
  for (const [key, asset] of [...afterAssets].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      JSON.stringify(canonicalValue(beforeAssets.get(key))) !==
      JSON.stringify(canonicalValue(asset))
    )
      add({ op: 'UPSERT_ASSET', value: asset })
  }
  for (const [key] of [...beforeAssets].sort(([left], [right]) => left.localeCompare(right))) {
    if (!afterAssets.has(key)) add({ op: 'RETIRE_ASSET', assetId: key })
  }
  if (
    JSON.stringify(canonicalValue(before.evaluation)) !==
    JSON.stringify(canonicalValue(after.evaluation))
  )
    add({ op: 'SET_EVALUATION_REFERENCES', value: after.evaluation })
  if (operations.length === 0) throw new Error('Cannot create an empty deployment patch.')
  return VenueDeploymentPatchManifest.parse({
    schemaVersion: 2,
    packageType: 'PATCH',
    manifestId: metadata.manifestId,
    venueRef: after.venueRef,
    idempotencyKey: metadata.idempotencyKey,
    provenance: after.provenance,
    baseManifestHash,
    operations,
  })
}
