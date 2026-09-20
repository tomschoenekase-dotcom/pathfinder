import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CharacterSpec } from '@pathfinder/character-factory'
import {
  CharacterRuntimePackSchema,
  canonicalCharacterRuntimePack,
} from '@pathfinder/contracts/character-runtime-pack'
import {
  CustomCharacterPublicationBindingSchema,
  type CustomCharacterPublicationBinding,
} from '@pathfinder/contracts/native-venue-deployment'
import type { db } from '../client'

const Id = z.string().min(1).max(191)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const ArtifactReferenceBase = z
  .object({
    bucket: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    objectKey: z.string().min(1).max(1000),
    sha256: Hash,
    byteLength: z.number().int().positive().max(12_000_000),
    mediaType: z.literal('application/vnd.pathfinder.character+json'),
    characterId: Id,
    characterVersion: z.number().int().positive(),
  })
  .strict()
const ArtifactReference = z.discriminatedUnion('kind', [
  ArtifactReferenceBase.extend({
    kind: z.literal('character-bundle-v1'),
    versionId: z.string().min(1).max(1000),
  }),
  ArtifactReferenceBase.extend({
    kind: z.literal('character-bundle-content-v1'),
  }),
])
const ReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: Id,
    venueId: Id,
    exportJobId: Id,
    spec: z.unknown(),
    artifactReference: ArtifactReference,
    runtimePack: CharacterRuntimePackSchema,
    acceptedCandidate: z
      .object({
        artifactReference: ArtifactReference,
        spec: z.unknown(),
        artifactFingerprint: Hash,
      })
      .strict(),
  })
  .strict()
export const VERIFIED_CHARACTER_EXPORT_RECEIPT_KEY = 'verifiedExportReceipt' as const
export const VERIFIED_CHARACTER_EXPORT_AUDIT_ACTION = 'character-factory.export-verified' as const
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function stable(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, next]) => [key, canonical(next)]),
          )
        : item
  return JSON.stringify(canonical(value))
}

export function createVerifiedCharacterExportReceipt(input: {
  tenantId: string
  venueId: string
  exportJobId: string
  spec: CharacterSpec
  artifactReference: unknown
  runtimePack: unknown
  acceptedCandidate: {
    artifactReference: unknown
    spec: CharacterSpec
    artifactFingerprint: string
  }
}) {
  const receipt = ReceiptSchema.parse({ ...input, schemaVersion: 1 })
  const spec = input.spec
  const candidate = input.acceptedCandidate.spec
  if (
    spec.status !== 'exported' ||
    spec.characterId !== receipt.runtimePack.characterId ||
    spec.version !== receipt.runtimePack.characterVersion ||
    spec.source.sha256 !== receipt.runtimePack.sourceSha256 ||
    spec.rigFamily !== receipt.runtimePack.family ||
    receipt.artifactReference.characterId !== spec.characterId ||
    receipt.artifactReference.characterVersion !== spec.version ||
    !Number.isInteger(spec.revision) ||
    spec.revision < 2 ||
    candidate.status !== 'candidate' ||
    candidate.revision + 1 !== spec.revision ||
    stable({ ...spec, status: 'candidate', revision: candidate.revision }) !== stable(candidate) ||
    receipt.acceptedCandidate.artifactReference.characterId !== candidate.characterId ||
    receipt.acceptedCandidate.artifactReference.characterVersion !== candidate.version
  ) {
    throw new Error('Verified export receipt does not match the exported specification.')
  }
  return { ...receipt, spec, acceptedCandidate: { ...receipt.acceptedCandidate, spec: candidate } }
}
export type VerifiedCharacterExportReceipt = ReturnType<typeof createVerifiedCharacterExportReceipt>
export function verifiedCharacterExportReceiptHash(
  receipt: VerifiedCharacterExportReceipt,
): string {
  return sha(stable(receipt))
}

type Reader = Pick<
  typeof db,
  'characterFactoryJob' | 'characterCandidateReviewDecision' | 'customCharacter' | 'auditLog'
>
export type CustomCharacterPublicationEvidence = {
  binding: CustomCharacterPublicationBinding
  artifactReference: VerifiedCharacterExportReceipt['artifactReference']
  spec: CharacterSpec
  runtimePack: VerifiedCharacterExportReceipt['runtimePack']
  acceptedCandidate: VerifiedCharacterExportReceipt['acceptedCandidate']
}
export type NativeCustomCharacterPublicationOptions = {
  verifyCustomCharacterPublication?: (
    input: CustomCharacterPublicationEvidence & { tenantId: string; venueId: string },
  ) => Promise<void>
}

/** Reads an immutable ACCEPT→EXPORT receipt. Mutable draft fields are checked only for a new publication. */
export async function readCustomCharacterPublicationEvidence(
  client: Reader,
  input: {
    tenantId: string
    venueId: string
    binding: CustomCharacterPublicationBinding
    requireCurrentCandidate: boolean
  },
): Promise<CustomCharacterPublicationEvidence> {
  const binding = CustomCharacterPublicationBindingSchema.parse(input.binding)
  const scope = { tenantId: input.tenantId, venueId: input.venueId }
  const [decision, job, character] = await Promise.all([
    client.characterCandidateReviewDecision.findFirst({
      where: {
        ...scope,
        id: binding.decisionId,
        customCharacterId: binding.characterId,
        decision: 'ACCEPT',
        resultingJobId: binding.exportJobId,
      },
    }),
    client.characterFactoryJob.findFirst({
      where: {
        ...scope,
        id: binding.exportJobId,
        customCharacterId: binding.characterId,
        action: 'EXPORT',
        status: 'SUCCEEDED',
      },
    }),
    client.customCharacter.findFirst({ where: { ...scope, id: binding.characterId } }),
  ])
  if (
    !decision ||
    !job ||
    !character ||
    character.status === 'ARCHIVED' ||
    job.cancelRequestedAt ||
    decision.candidateVersion !== binding.characterVersion ||
    decision.candidateRevision + 1 !== binding.characterRevision ||
    job.baseVersion !== decision.candidateVersion ||
    job.baseRevision !== decision.candidateRevision ||
    job.resultVersion !== binding.characterVersion ||
    job.resultRevision !== binding.characterRevision
  )
    throw new Error('Custom character ACCEPT/export lineage is unavailable.')
  const payload = job.resultPayload as Record<string, unknown> | null
  const parsed = ReceiptSchema.parse(payload?.[VERIFIED_CHARACTER_EXPORT_RECEIPT_KEY])
  // Only a server-created audit digest can distinguish receipts from historical caller payloads.
  const spec = parsed.spec as CharacterSpec
  const receipt = createVerifiedCharacterExportReceipt({
    ...parsed,
    spec,
    acceptedCandidate: {
      ...parsed.acceptedCandidate,
      spec: parsed.acceptedCandidate.spec as CharacterSpec,
    },
  })
  if (
    receipt.tenantId !== scope.tenantId ||
    receipt.venueId !== scope.venueId ||
    receipt.exportJobId !== job.id ||
    spec.characterId !== binding.characterId ||
    spec.version !== binding.characterVersion ||
    spec.revision !== binding.characterRevision ||
    receipt.acceptedCandidate.artifactFingerprint !== decision.artifactFingerprint ||
    spec.source.sha256 !== binding.sourceSha256 ||
    receipt.artifactReference.sha256 !== binding.artifactSha256 ||
    receipt.artifactReference.kind !== 'character-bundle-v1' ||
    receipt.artifactReference.versionId !== binding.artifactVersionId ||
    sha(canonicalCharacterRuntimePack(receipt.runtimePack)) !== binding.runtimePackSha256
  )
    throw new Error('Custom character publication binding changed.')
  const audit = await client.auditLog.findFirst({
    where: {
      tenantId: scope.tenantId,
      action: VERIFIED_CHARACTER_EXPORT_AUDIT_ACTION,
      targetType: 'CharacterFactoryJob',
      targetId: job.id,
      afterState: { path: ['receiptSha256'], equals: verifiedCharacterExportReceiptHash(receipt) },
    },
    select: { id: true },
  })
  if (!audit) throw new Error('Custom character export has no server verification evidence.')
  if (
    input.requireCurrentCandidate &&
    (character.version !== binding.characterVersion ||
      character.revision !== binding.characterRevision ||
      stable(character.assetStorageReference) !== stable(receipt.artifactReference) ||
      stable(
        (character.capabilityMetadata as { characterFactory?: { spec?: unknown } })
          ?.characterFactory?.spec,
      ) !== stable(spec))
  )
    throw new Error('A newer custom character draft fenced this publication.')
  return {
    binding,
    artifactReference: receipt.artifactReference,
    spec,
    runtimePack: receipt.runtimePack,
    acceptedCandidate: receipt.acceptedCandidate,
  }
}
