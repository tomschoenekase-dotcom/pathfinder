import { z } from 'zod'

import type { AgentBridgeRunnerConfig } from './agent-bridge-runner'
import { createAgentBridgeHttpClient } from './agent-bridge-runner'

const requestId = z.string().trim().min(1).max(191)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const factoryStates = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'happy',
  'sad',
  'success',
  'error',
  'reaction',
] as const
const characterSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    characterId: requestId,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(120),
    rigFamily: z.string().trim().min(1).max(191),
    rigCapabilities: z.unknown().optional(),
    source: z
      .object({
        kind: z.literal('imported'),
        sourceUrl: z.string().url().max(1_000),
        sourceRevision: z.string().min(1).max(500),
        license: z.string().min(1).max(500),
        attribution: z.string().min(1).max(2_000),
        importedAt: z.string().datetime(),
        sha256,
        mediaType: z.enum(['image/svg+xml', 'image/png']),
        byteLength: z.number().int().positive().max(2_000_000),
      })
      .strict(),
    masterReference: z.string().min(1).max(500),
    protectedTraits: z.array(z.string().trim().min(1).max(200)).max(40),
    slotMap: z
      .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/u), z.string().min(1).max(500))
      .superRefine((value, context) => {
        if (Object.keys(value).length > 32)
          context.addIssue({ code: 'custom', message: 'Character slot map is too large.' })
      }),
    supportedStates: z.array(z.string().min(1).max(32)).length(10),
    status: z.enum([
      'requested',
      'generating',
      'candidate',
      'invalid',
      'exported',
      'active',
      'archived',
    ]),
  })
  .strict()
const artifactReferenceBaseSchema = z
  .object({
    bucket: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u),
    objectKey: z.string().min(1).max(1_000),
    sha256,
    byteLength: z.number().int().positive().max(12_000_000),
    mediaType: z.literal('application/vnd.pathfinder.character+json'),
    characterId: requestId,
    characterVersion: z.number().int().positive(),
  })
  .strict()
const artifactReferenceSchema = z.discriminatedUnion('kind', [
  artifactReferenceBaseSchema.extend({
    kind: z.literal('character-bundle-v1'),
    versionId: z.string().min(1).max(1_000),
  }),
  artifactReferenceBaseSchema.extend({
    kind: z.literal('character-bundle-content-v1'),
  }),
])
const completionSchema = z
  .object({
    requestId,
    resultPayload: z.record(z.unknown()).superRefine((value, context) => {
      try {
        if (JSON.stringify(value).length > 100_000)
          context.addIssue({ code: 'custom', message: 'Result payload is too large.' })
      } catch {
        context.addIssue({ code: 'custom', message: 'Result payload is not serializable.' })
      }
    }),
    characterSpec: characterSpecSchema.optional(),
    assetStorageReference: artifactReferenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.characterSpec === undefined) !== (value.assetStorageReference === undefined))
      context.addIssue({
        code: 'custom',
        message:
          'A retained artifact reference and its exact character spec must be supplied together.',
      })
    if (
      value.characterSpec &&
      value.assetStorageReference &&
      (value.characterSpec.characterId !== value.assetStorageReference.characterId ||
        value.characterSpec.version !== value.assetStorageReference.characterVersion)
    )
      context.addIssue({
        code: 'custom',
        message: 'Retained artifact identity does not match the character result.',
      })
    if (
      value.characterSpec &&
      (new Set(value.characterSpec.supportedStates).size !== factoryStates.length ||
        !factoryStates.every((state) => value.characterSpec?.supportedStates.includes(state)))
    )
      context.addIssue({ code: 'custom', message: 'Character semantic states are incomplete.' })
  })

const requesterJobSchema = z
  .object({
    requestId,
    venueId: z.string().trim().min(1).max(191),
  })
  .passthrough()
const claimSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('claimed'),
      job: requesterJobSchema.extend({ leaseToken: z.string().uuid() }),
    })
    .strict(),
  z
    .object({
      state: z.literal('not-claimed'),
      // Canonical requesterJob deliberately redacts the lease token when a claim loses.
      job: requesterJobSchema,
    })
    .strict(),
])
const completedSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId,
    status: z.literal('SUCCEEDED'),
  })
  .passthrough()

export class CharacterFactoryExecutorError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CLAIM'
      | 'LEASE_REJECTED'
      | 'COMPLETION_INDETERMINATE'
      | 'INVALID_COMPLETION',
    message: string,
  ) {
    super(message)
    this.name = 'CharacterFactoryExecutorError'
  }
}

export type CharacterFactoryCompletion = z.infer<typeof completionSchema>
type BridgeCall = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>

/**
 * Executes one explicitly named factory request. There is intentionally no queue scan:
 * discovery requires a separately authorized durable scheduling interface. Artifact bytes
 * are never accepted here; the canonical bridge verifies the already-retained reference.
 */
export async function runCharacterFactoryExecutor(
  config: AgentBridgeRunnerConfig,
  rawCompletion: unknown,
  signal: AbortSignal,
  dependencies: { call?: BridgeCall } = {},
) {
  const completion = completionSchema.parse(rawCompletion)
  const call = dependencies.call ?? createAgentBridgeHttpClient(config)
  const scope = { venueId: config.venueId, requestId: completion.requestId }
  const claim = claimSchema.parse(await call('claimCharacterFactoryJob', scope, signal))
  if (claim.state === 'not-claimed') return { state: 'not-claimed' as const }
  if (
    claim.job.requestId !== completion.requestId ||
    claim.job.venueId !== config.venueId ||
    !claim.job.leaseToken
  )
    throw new CharacterFactoryExecutorError(
      'INVALID_CLAIM',
      'Character claim did not match its request.',
    )

  const lease = { ...scope, leaseToken: claim.job.leaseToken }
  try {
    // The bridge endpoint supports a canonical lease/cancellation fence. Renew once immediately
    // before completion; it is not a polling or discovery mechanism.
    await call('heartbeatCharacterFactoryJob', lease, signal)
  } catch {
    await call(
      'failCharacterFactoryJob',
      {
        ...lease,
        errorCode: 'CHARACTER_EXECUTOR_LEASE_REJECTED',
        errorMessage: 'Character executor lease renewal was rejected before completion.',
      },
      signal,
    ).catch(() => undefined)
    throw new CharacterFactoryExecutorError(
      'LEASE_REJECTED',
      'Character executor lease was rejected before completion.',
    )
  }
  try {
    const rawResult = await call(
      'completeCharacterFactoryJob',
      {
        ...lease,
        resultPayload: completion.resultPayload,
        ...(completion.characterSpec === undefined
          ? {}
          : { characterSpec: completion.characterSpec }),
        ...(completion.assetStorageReference === undefined
          ? {}
          : { assetStorageReference: completion.assetStorageReference }),
      },
      signal,
    )
    const result = completedSchema.safeParse(rawResult)
    if (
      !result.success ||
      result.data.venueId !== config.venueId ||
      result.data.requestId !== completion.requestId
    )
      throw new CharacterFactoryExecutorError(
        'INVALID_COMPLETION',
        'Character completion response did not confirm the exact request.',
      )
    return { state: 'completed' as const, result: result.data }
  } catch {
    // A completion request can commit before its response is lost. Never issue a failure write
    // after calling completion; a later exact request read is the only safe reconciliation.
    throw new CharacterFactoryExecutorError(
      'COMPLETION_INDETERMINATE',
      'Character completion outcome is indeterminate; reconcile the exact request before retrying.',
    )
  }
}

export function parseCharacterFactoryCompletion(raw: unknown) {
  return completionSchema.parse(raw)
}
