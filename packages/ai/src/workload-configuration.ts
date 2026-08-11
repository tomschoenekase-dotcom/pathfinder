import { z } from 'zod'

import { AI_EMBEDDING_MODEL_REGISTRY, type AiEmbeddingModelKey } from './embedding-model-registry'
import { AI_MODEL_REGISTRY, type AiModelKey } from './model-registry'

export const AI_CONFIGURATION_VERSION = 'ai-workload-config-v1' as const

export const AI_PROVIDER_REGISTRY = {
  anthropic: { id: 'anthropic', capabilities: ['TEXT'] },
  openai: { id: 'openai', capabilities: ['EMBEDDING'] },
} as const

export type AiProviderId = keyof typeof AI_PROVIDER_REGISTRY
export type AiWorkloadId = AiModelKey | AiEmbeddingModelKey
export type AiModelKind = 'TEXT' | 'EMBEDDING'

export type AiCentralModel = {
  key: AiWorkloadId
  provider: AiProviderId
  model: string
  kind: AiModelKind
  pricingVersion: string
  pricingUsdPerMillionTokens: Readonly<{
    input: number
    output?: number
    cacheWrite?: number
    cacheRead?: number
  }>
  limits: Readonly<{
    timeoutMs: number
    maxAttempts: number
    maxInputUtf8Bytes: number
    maxBillableInputTokens: number
    maxOutputTokens?: number
    dimensions?: number
  }>
}

const textModels = (
  Object.entries(AI_MODEL_REGISTRY) as [AiModelKey, (typeof AI_MODEL_REGISTRY)[AiModelKey]][]
).map(
  ([key, spec]) =>
    [
      key,
      {
        key,
        provider: spec.provider,
        model: spec.model,
        kind: 'TEXT',
        pricingVersion: spec.pricingVersion,
        pricingUsdPerMillionTokens: spec.pricingUsdPerMillionTokens,
        limits: {
          timeoutMs: spec.timeoutMs,
          maxAttempts: spec.maxAttempts,
          maxInputUtf8Bytes: spec.maxInputUtf8Bytes,
          maxBillableInputTokens: spec.maxBillableInputTokens,
          maxOutputTokens: spec.maxOutputTokens,
        },
      } satisfies AiCentralModel,
    ] as const,
)

const embeddingModels = (
  Object.entries(AI_EMBEDDING_MODEL_REGISTRY) as [
    AiEmbeddingModelKey,
    (typeof AI_EMBEDDING_MODEL_REGISTRY)[AiEmbeddingModelKey],
  ][]
).map(
  ([key, spec]) =>
    [
      key,
      {
        key,
        provider: spec.provider,
        model: spec.model,
        kind: 'EMBEDDING',
        pricingVersion: spec.pricingVersion,
        pricingUsdPerMillionTokens: { input: spec.inputUsdPerMillionTokens },
        limits: {
          timeoutMs: spec.timeoutMs,
          maxAttempts: spec.maxAttempts,
          maxInputUtf8Bytes: spec.maxInputUtf8Bytes,
          maxBillableInputTokens: spec.maxBillableInputTokens,
          dimensions: spec.dimensions,
        },
      } satisfies AiCentralModel,
    ] as const,
)

/** A read-only projection of the provider registries; it never creates a provider client. */
export const AI_CENTRAL_MODEL_REGISTRY = Object.freeze(
  Object.fromEntries([...textModels, ...embeddingModels]),
) as Readonly<Record<AiWorkloadId, AiCentralModel>>

const workloadIds = Object.keys(AI_CENTRAL_MODEL_REGISTRY) as [AiWorkloadId, ...AiWorkloadId[]]

export const AiConfigurationOverrideSchema = z
  .object({
    activation: z.enum(['DISABLED', 'ENABLED']).default('DISABLED'),
    scope: z.discriminatedUnion('level', [
      z.object({ level: z.literal('PLATFORM') }).strict(),
      z.object({ level: z.literal('WORKLOAD'), workloadId: z.enum(workloadIds) }).strict(),
      z
        .object({
          level: z.literal('CLIENT'),
          clientId: z.string().min(1).max(128),
          workloadId: z.enum(workloadIds),
        })
        .strict(),
      z
        .object({
          level: z.literal('VENUE'),
          clientId: z.string().min(1).max(128),
          venueId: z.string().min(1).max(128),
          workloadId: z.enum(workloadIds),
        })
        .strict(),
    ]),
    values: z
      .object({
        primaryModelKey: z.enum(workloadIds).optional(),
        fallback: z
          .object({
            enabled: z.boolean(),
            modelKeys: z.array(z.enum(workloadIds)).max(3),
          })
          .strict()
          .optional(),
        timeoutMs: z.number().int().min(100).max(120_000).optional(),
        maxAttempts: z.number().int().min(1).max(5).optional(),
        maxOutputTokens: z.number().int().min(1).max(32_000).nullable().optional(),
        /** 1e-8 USD units. This is a configured ceiling, not pricing or an invoice. */
        requestBudgetCeilingE8Usd: z.string().regex(/^\d+$/u).nullable().optional(),
      })
      .strict(),
    /** Required for spend-expanding, fallback-enabling, or model-selection changes. */
    unsafeChangesEnabled: z.boolean().default(false),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()

export type AiConfigurationOverride = z.infer<typeof AiConfigurationOverrideSchema>
export type AiConfigurationSourceLevel = 'PLATFORM' | 'WORKLOAD' | 'CLIENT' | 'VENUE'

export type AiEffectiveWorkloadConfiguration = {
  configurationVersion: typeof AI_CONFIGURATION_VERSION
  workloadId: AiWorkloadId
  kind: AiModelKind
  primaryModelKey: AiWorkloadId
  fallback: { enabled: boolean; modelKeys: AiWorkloadId[] }
  timeoutMs: number
  maxAttempts: number
  maxOutputTokens: number | null
  requestBudgetCeilingE8Usd: string | null
  model: AiCentralModel
  sources: Record<
    | 'primaryModelKey'
    | 'fallback'
    | 'timeoutMs'
    | 'maxAttempts'
    | 'maxOutputTokens'
    | 'requestBudgetCeilingE8Usd',
    AiConfigurationSourceLevel
  >
}

function assertScopeMatches(
  override: AiConfigurationOverride,
  workloadId: AiWorkloadId,
  clientId?: string,
  venueId?: string,
): void {
  const scope = override.scope
  if ('workloadId' in scope && scope.workloadId !== workloadId)
    throw new Error(`AI ${scope.level.toLowerCase()} override targets another workload`)
  if ('clientId' in scope && scope.clientId !== clientId)
    throw new Error(`AI ${scope.level.toLowerCase()} override targets another client`)
  if ('venueId' in scope && scope.venueId !== venueId)
    throw new Error('AI venue override targets another venue')
}

function budgetIncreases(current: string | null, next: string | null): boolean {
  if (current === null) return false
  if (next === null) return true
  return BigInt(next) > BigInt(current)
}

export function resolveAiWorkloadConfiguration(params: {
  workloadId: AiWorkloadId
  clientId?: string
  venueId?: string
  overrides?: unknown[]
}): AiEffectiveWorkloadConfiguration {
  if (params.venueId && !params.clientId)
    throw new Error('AI venue resolution requires its owning client identity')

  const base = AI_CENTRAL_MODEL_REGISTRY[params.workloadId]
  if (!base) throw new Error('Unknown AI workload')

  const effective: AiEffectiveWorkloadConfiguration = {
    configurationVersion: AI_CONFIGURATION_VERSION,
    workloadId: params.workloadId,
    kind: base.kind,
    primaryModelKey: params.workloadId,
    fallback: { enabled: false, modelKeys: [] },
    timeoutMs: base.limits.timeoutMs,
    maxAttempts: base.limits.maxAttempts,
    maxOutputTokens: base.limits.maxOutputTokens ?? null,
    requestBudgetCeilingE8Usd: null,
    model: base,
    sources: {
      primaryModelKey: 'PLATFORM',
      fallback: 'PLATFORM',
      timeoutMs: 'PLATFORM',
      maxAttempts: 'PLATFORM',
      maxOutputTokens: 'PLATFORM',
      requestBudgetCeilingE8Usd: 'PLATFORM',
    },
  }

  const rank: Record<AiConfigurationSourceLevel, number> = {
    PLATFORM: 0,
    WORKLOAD: 1,
    CLIENT: 2,
    VENUE: 3,
  }
  const parsed = (params.overrides ?? []).map((value) => AiConfigurationOverrideSchema.parse(value))
  parsed.sort((left, right) => rank[left.scope.level] - rank[right.scope.level])

  for (const override of parsed) {
    assertScopeMatches(override, params.workloadId, params.clientId, params.venueId)
    if (override.activation === 'DISABLED') continue
    const next = override.values
    const selected = next.primaryModelKey
      ? AI_CENTRAL_MODEL_REGISTRY[next.primaryModelKey]
      : effective.model
    if (selected.kind !== effective.kind)
      throw new Error('AI override cannot change the workload model kind')
    if (
      next.fallback?.modelKeys.some((key) => AI_CENTRAL_MODEL_REGISTRY[key].kind !== effective.kind)
    )
      throw new Error('AI fallback cannot cross workload model kinds')

    const unsafe =
      (next.primaryModelKey !== undefined && next.primaryModelKey !== effective.primaryModelKey) ||
      next.fallback?.enabled === true ||
      (next.maxAttempts !== undefined && next.maxAttempts > effective.maxAttempts) ||
      (next.maxOutputTokens !== undefined &&
        next.maxOutputTokens !== null &&
        (effective.maxOutputTokens === null || next.maxOutputTokens > effective.maxOutputTokens)) ||
      (next.requestBudgetCeilingE8Usd !== undefined &&
        budgetIncreases(effective.requestBudgetCeilingE8Usd, next.requestBudgetCeilingE8Usd))
    if (unsafe && !override.unsafeChangesEnabled)
      throw new Error('AI override contains a default-off unsafe change')

    const level = override.scope.level
    if (next.primaryModelKey !== undefined) {
      effective.primaryModelKey = next.primaryModelKey
      effective.model = selected
      effective.sources.primaryModelKey = level
    }
    if (next.fallback !== undefined) {
      effective.fallback = { ...next.fallback, modelKeys: [...next.fallback.modelKeys] }
      effective.sources.fallback = level
    }
    if (next.timeoutMs !== undefined) {
      effective.timeoutMs = next.timeoutMs
      effective.sources.timeoutMs = level
    }
    if (next.maxAttempts !== undefined) {
      effective.maxAttempts = next.maxAttempts
      effective.sources.maxAttempts = level
    }
    if (next.maxOutputTokens !== undefined) {
      effective.maxOutputTokens = next.maxOutputTokens
      effective.sources.maxOutputTokens = level
    }
    if (next.requestBudgetCeilingE8Usd !== undefined) {
      effective.requestBudgetCeilingE8Usd = next.requestBudgetCeilingE8Usd
      effective.sources.requestBudgetCeilingE8Usd = level
    }
  }

  return effective
}
