import { createHash } from 'node:crypto'

import {
  FACTORY_STATES,
  readCharacterBundle,
  resolveRig,
  type CharacterExportArtifact,
  type CharacterSpec,
} from '@pathfinder/character-factory'
import {
  claimCharacterFactoryJobAction,
  completeCharacterFactoryJobAction,
  CustomCharacterFactoryActionError,
  db,
  prepareCharacterFactoryJobAction,
  readCustomCharacterFactoryAction,
  submitCharacterCandidateReviewBrief,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { createCharacterArtifactStorage } from '../../../packages/api/src/lib/character-artifact-storage'
import { z } from 'zod'

export const CHARACTER_IMPORT_MAX_BYTES = 12_000_000

type ImportInput = {
  tenantId: string
  venueId: string
  requestId: string
  brief: string
  rationale: string
  sourceProvenance: 'GENERATED' | 'IMPORTED' | 'IMPORTED_FIXTURE'
  bytes: Uint8Array
  actorId: string
}

type ImportResult = {
  characterId: string
  displayName: string
  briefId: string
  jobId: string
  replayed: boolean
}

const importedSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    characterId: z.string().trim().min(1).max(191),
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(120),
    rigFamily: z.union([
      z.enum(['morph-v1', 'compact-creature-v1', 'humanoid-v1']),
      z.string().regex(/^custom:[a-z0-9][a-z0-9-]{2,80}$/u),
    ]),
    rigCapabilities: z
      .object({
        schemaVersion: z.literal(1),
        familyId: z.union([
          z.enum(['morph-v1', 'compact-creature-v1', 'humanoid-v1']),
          z.string().regex(/^custom:[a-z0-9][a-z0-9-]{2,80}$/u),
        ]),
        anatomyClass: z.enum(['creature', 'humanoid', 'morph', 'object', 'custom']),
        requiredSlots: z
          .array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/u))
          .min(1)
          .max(32),
        stateControls: z.record(
          z.enum(FACTORY_STATES),
          z.array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/u)).max(16),
        ),
      })
      .strict()
      .optional(),
    source: z
      .object({
        kind: z.literal('imported'),
        sourceUrl: z.string().url(),
        sourceRevision: z.string().min(1).max(200),
        license: z.string().min(1).max(100),
        attribution: z.string().min(1).max(500),
        importedAt: z.string().datetime(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        mediaType: z.enum(['image/svg+xml', 'image/png']),
        byteLength: z.number().int().positive().max(2_000_000),
      })
      .strict(),
    masterReference: z.string().min(1).max(500),
    protectedTraits: z.array(z.string().trim().min(1).max(200)).max(40),
    slotMap: z
      .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/u), z.string().min(1).max(500))
      .refine((value) => Object.keys(value).length <= 32),
    supportedStates: z
      .array(z.enum(FACTORY_STATES))
      .length(FACTORY_STATES.length)
      .refine((value) => new Set(value).size === FACTORY_STATES.length),
    status: z.literal('candidate'),
  })
  .strict()

function fail(message: string): never {
  throw new CustomCharacterFactoryActionError('INVALID_INPUT', message)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function artifact(bytes: Uint8Array): CharacterExportArtifact {
  if (bytes.byteLength < 1 || bytes.byteLength > CHARACTER_IMPORT_MAX_BYTES)
    fail('The character bundle exceeds the 12 MB import limit.')
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail('The import must be a readable character bundle JSON file.')
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    fail('The import must be a character bundle object.')
  const root = decoded as Record<string, unknown>
  if (root.kind !== 'pathfinder-character-bundle' || root.runtimePack !== undefined)
    fail('Bot Maker imports require a static appearance bundle without a runtime pack.')
  const spec = root.spec as Partial<CharacterSpec> | undefined
  if (spec?.status !== 'candidate') fail('Only candidate character bundles can enter review.')
  if (
    !Array.isArray(spec?.supportedStates) ||
    spec.supportedStates.length !== FACTORY_STATES.length
  )
    fail('The bundle must declare every supported character state.')
  const digest = createHash('sha256').update(bytes).digest('hex')
  return {
    mediaType: 'application/vnd.pathfinder.character+json',
    schemaVersion: 1,
    characterId: typeof spec.characterId === 'string' ? spec.characterId : '',
    characterVersion: typeof spec.version === 'number' ? spec.version : 0,
    sha256: digest,
    byteLength: bytes.byteLength,
    bytes,
  }
}

export async function parseCharacterImportBundle(bytes: Uint8Array) {
  const bundle = artifact(bytes)
  let parsed: z.infer<typeof importedSpecSchema>
  try {
    parsed = importedSpecSchema.parse(await readCharacterBundle(bundle))
  } catch {
    fail('The bundle does not match the verified candidate character schema.')
  }
  const decoded = JSON.parse(new TextDecoder().decode(bundle.bytes)) as { spec?: unknown }
  if (stable(decoded.spec) !== stable(parsed))
    fail('The bundle contains non-canonical character metadata.')
  const spec = parsed as unknown as CharacterSpec
  if (!resolveRig(spec)) fail('The bundle rig family is unsupported.')
  if (
    spec.status !== 'candidate' ||
    spec.version !== 1 ||
    spec.revision !== 1 ||
    spec.characterId !== bundle.characterId
  )
    fail('Imported appearance candidates must start at version 1 and revision 1.')
  return { bundle, spec }
}

function sameSpec(left: CharacterSpec, right: CharacterSpec) {
  return stable(left) === stable(right)
}

function sameReference(value: unknown, artifactValue: CharacterExportArtifact) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const reference = value as Record<string, unknown>
  return (
    typeof reference.kind === 'string' &&
    reference.sha256 === artifactValue.sha256 &&
    reference.byteLength === artifactValue.byteLength &&
    reference.characterId === artifactValue.characterId &&
    reference.characterVersion === artifactValue.characterVersion
  )
}

export async function importCharacterBundle(input: ImportInput): Promise<ImportResult> {
  const { bundle, spec } = await parseCharacterImportBundle(input.bytes)
  if (!input.tenantId.trim() || !input.venueId.trim() || !input.requestId.trim())
    fail('Tenant, venue, and request identifiers are required.')
  if (!input.brief.trim() || input.brief.length > 4_000) fail('A bounded review brief is required.')
  if (!input.rationale.trim() || input.rationale.length > 2_000)
    fail('A bounded rationale is required.')

  return withTenantIsolationBypass(async () => {
    const venue = await db.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new CustomCharacterFactoryActionError('NOT_FOUND', 'Venue not found.')

    let existing: Awaited<ReturnType<typeof readCustomCharacterFactoryAction>> | undefined
    try {
      existing = await readCustomCharacterFactoryAction({
        tenantId: input.tenantId,
        venueId: input.venueId,
        characterId: spec.characterId,
      })
    } catch (error) {
      if (!(error instanceof CustomCharacterFactoryActionError) || error.code !== 'NOT_FOUND')
        throw error
    }

    const expectedPayload = {
      characterId: spec.characterId,
      sourceAssetReference: spec.masterReference,
      sourceSha256: spec.source.sha256,
    }
    let jobId: string
    let replayed = false
    if (existing) {
      if (
        existing.status !== 'REVIEW' ||
        !sameSpec(existing.spec, spec) ||
        !sameReference(existing.assetStorageReference, bundle)
      )
        throw new CustomCharacterFactoryActionError(
          'CONFLICT',
          'This request ID or character identity is already bound to different content.',
        )
      await createCharacterArtifactStorage().getVerified({
        tenantId: input.tenantId,
        venueId: input.venueId,
        reference: existing.assetStorageReference,
        expectedSpec: spec,
      })
      const prior = await db.characterFactoryJob.findFirst({
        where: { tenantId: input.tenantId, venueId: input.venueId, requestId: input.requestId },
        select: {
          id: true,
          action: true,
          status: true,
          customCharacterId: true,
          requestPayload: true,
        },
      })
      if (
        !prior ||
        prior.action !== 'CREATE_FROM_IMPORT' ||
        prior.status !== 'SUCCEEDED' ||
        prior.customCharacterId !== spec.characterId ||
        stable(prior.requestPayload) !== stable(expectedPayload)
      )
        throw new CustomCharacterFactoryActionError(
          'CONFLICT',
          'This request is already bound to an incomplete or different import.',
        )
      jobId = prior.id
      const priorBrief = await db.characterCandidateReviewBrief.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          customCharacterId: spec.characterId,
          candidateVersion: spec.version,
          candidateRevision: spec.revision,
        },
        select: { id: true, brief: true, rationale: true, sourceProvenance: true },
      })
      if (
        priorBrief &&
        (priorBrief.brief !== input.brief ||
          priorBrief.rationale !== input.rationale ||
          priorBrief.sourceProvenance !== input.sourceProvenance)
      )
        throw new CustomCharacterFactoryActionError(
          'CONFLICT',
          'This request already has a different review brief.',
        )
      if (priorBrief)
        return {
          characterId: spec.characterId,
          displayName: spec.displayName,
          briefId: priorBrief.id,
          jobId,
          replayed: true,
        }
      replayed = true
    } else {
      const prepared = await prepareCharacterFactoryJobAction({
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        action: 'CREATE_FROM_IMPORT',
        requestPayload: expectedPayload,
        actor: { id: input.actorId, role: 'PLATFORM_ADMIN' },
      })
      jobId = prepared.job.id
      replayed = prepared.replayed

      if (prepared.job.status !== 'SUCCEEDED') {
        const reference = await createCharacterArtifactStorage().put({
          tenantId: input.tenantId,
          venueId: input.venueId,
          artifact: bundle,
        })
        const claimed = await claimCharacterFactoryJobAction({
          tenantId: input.tenantId,
          venueId: input.venueId,
          requestId: input.requestId,
        })
        if (claimed.state !== 'claimed')
          throw new CustomCharacterFactoryActionError(
            'CONFLICT',
            'The import is already being processed; retry with the same request ID.',
          )
        if (!claimed.job.leaseToken)
          throw new CustomCharacterFactoryActionError(
            'CONFLICT',
            'The import lease was not returned; retry with the same request ID.',
          )
        const completed = await completeCharacterFactoryJobAction(
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            requestId: input.requestId,
            leaseToken: claimed.job.leaseToken,
            resultPayload: { source: 'bot-maker-import', publicationAuthorized: false },
            characterSpec: spec,
            assetStorageReference: reference,
            actor: { id: input.actorId, role: 'PLATFORM_ADMIN' },
          },
          undefined,
          {
            verifyArtifact: async ({ expectedSpec }) => {
              const verified = await createCharacterArtifactStorage().getVerified({
                tenantId: input.tenantId,
                venueId: input.venueId,
                reference,
                expectedSpec,
              })
              return { reference: verified.reference, spec: verified.spec }
            },
          },
        )
        jobId = completed.id
      }
    }

    const review = await submitCharacterCandidateReviewBrief({
      tenantId: input.tenantId,
      venueId: input.venueId,
      characterId: spec.characterId,
      brief: input.brief,
      rationale: input.rationale,
      sourceProvenance: input.sourceProvenance,
      actor: { id: input.actorId, role: 'PLATFORM_ADMIN', type: 'HUMAN' },
    })
    return {
      characterId: spec.characterId,
      displayName: spec.displayName,
      briefId: review.brief.id,
      jobId,
      replayed: replayed || review.replayed,
    }
  })
}
