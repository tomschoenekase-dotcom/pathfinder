import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  finalizeIntakeV1PackageHandoffInTransaction,
  readIntakeV1PackageHandoff,
} from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { VenuePackagePayload } from '../schemas/venue-package'
import { createVenuePackageDraftService } from '../routers/venue-package'
import { buildIntakeV1PackageCandidate } from './intake-v1-package-candidate'
import { venuePackagePayloadHash } from './venue-package-identity'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
export const IntakeV1PackageDraftCommand = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    submissionId: z.string().min(1).max(191),
    revision: z.number().int().min(1),
    operationId: z.string().uuid(),
    selectedMemberIds: z.array(z.string().min(1).max(191)).min(1).max(50),
    expectedManifestHash: hash,
    expectedCandidateHash: hash,
    expectedPayloadHash: hash,
    partialAcknowledged: z.boolean(),
  })
  .strict()
  .refine((input) => new Set(input.selectedMemberIds).size === input.selectedMemberIds.length, {
    message: 'Selected members must be unique.',
  })

function conflict(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message })
}

function sameMembers(left: unknown, right: string[]): boolean {
  return (
    Array.isArray(left) &&
    left.every((value) => typeof value === 'string') &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  )
}

/** Human admin adapter. Machine callers require their own authenticated approval adapter. */
export async function createIntakeV1PackageDraftForAdmin(request: {
  db: TRPCContext['db']
  actorId: string
  command: z.input<typeof IntakeV1PackageDraftCommand>
}) {
  const parsed = IntakeV1PackageDraftCommand.safeParse(request.command)
  if (!parsed.success || !request.actorId.trim())
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid V1 package draft command.' })
  const command = parsed.data
  const scope = { tenantId: command.tenantId, venueId: command.venueId }
  const revision = await request.db.intakeV1SubmissionRevision.findFirst({
    where: { ...scope, submissionId: command.submissionId, revision: command.revision },
    select: { id: true, manifestHash: true },
  })
  if (!revision) throw new TRPCError({ code: 'NOT_FOUND', message: 'V1 revision not found.' })
  if (revision.manifestHash !== command.expectedManifestHash) conflict('V1 manifest changed.')

  // Historical retries resolve their retained receipt before any mutable review projection.
  const prior = await readIntakeV1PackageHandoff(
    { ...scope, operationId: command.operationId },
    request.db,
  )
  if (
    prior &&
    (prior.revisionId !== revision.id ||
      prior.manifestHash !== command.expectedManifestHash ||
      prior.candidateHash !== command.expectedCandidateHash ||
      prior.payloadHash !== command.expectedPayloadHash ||
      prior.createdBy !== request.actorId ||
      prior.partialAcknowledged !== command.partialAcknowledged ||
      !sameMembers(prior.selectedMemberIds, command.selectedMemberIds))
  )
    conflict('This operation belongs to a different V1 package selection.')

  const candidateInput = {
    ...scope,
    submissionId: command.submissionId,
    revision: command.revision,
    selectedMemberIds: command.selectedMemberIds,
  }
  const candidate = prior
    ? null
    : await buildIntakeV1PackageCandidate({ db: request.db, ...candidateInput })
  if (candidate && (!candidate.ready || !candidate.payload))
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Selected V1 sources are not ready for a package draft.',
    })
  if (
    candidate &&
    (candidate.manifestHash !== command.expectedManifestHash ||
      candidate.candidateHash !== command.expectedCandidateHash ||
      candidate.payloadHash !== command.expectedPayloadHash)
  )
    conflict('V1 candidate changed. Preview it again before creating a draft.')
  if (
    candidate &&
    (candidate.remainingMemberIds.length > 0 || candidate.submissionOmissionCount > 0) &&
    !command.partialAcknowledged
  )
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Explicitly acknowledge the sources excluded from this package draft.',
    })

  const payload = VenuePackagePayload.parse(prior ? prior.packageDraft.payload : candidate!.payload)
  if (venuePackagePayloadHash(command.venueId, payload) !== command.expectedPayloadHash)
    conflict('Retained package payload identity does not match this command.')
  const selectedMemberIds = candidate?.selectedMemberIds ?? (prior!.selectedMemberIds as string[])
  try {
    return await createVenuePackageDraftService({
      db: request.db,
      tenantId: command.tenantId,
      actor: { type: 'HUMAN', id: request.actorId, role: 'PLATFORM_ADMIN' },
      input: { venueId: command.venueId, draftKey: command.operationId, payload },
      isolationLevel: 'Serializable',
      finalizer: async (finalized) => {
        if (
          finalized.createdBy !== request.actorId ||
          finalized.tenantId !== command.tenantId ||
          finalized.venueId !== command.venueId
        )
          conflict('Package actor or scope changed.')
        if (!finalized.replayed) {
          if (finalized.status !== 'DRAFT') conflict('Only a new draft can attach to V1.')
          if (finalized.preview.report.semanticDuplicateScan.status !== 'COMPLETE')
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Complete semantic review evidence is required.',
            })
          const current = await buildIntakeV1PackageCandidate({
            db: finalized.tx,
            ...candidateInput,
          })
          if (
            !current.ready ||
            current.revisionId !== revision.id ||
            current.manifestHash !== command.expectedManifestHash ||
            current.candidateHash !== command.expectedCandidateHash ||
            current.payloadHash !== command.expectedPayloadHash
          )
            conflict('V1 source review changed during draft creation.')
        } else if (!prior) {
          const replay = await readIntakeV1PackageHandoff(
            { ...scope, operationId: command.operationId },
            finalized.tx,
          )
          if (!replay) conflict('Existing package has no matching V1 handoff.')
        }
        return finalizeIntakeV1PackageHandoffInTransaction(finalized.tx, {
          ...scope,
          revisionId: revision.id,
          packageDraftId: finalized.packageId,
          operationId: command.operationId,
          manifestHash: command.expectedManifestHash,
          candidateHash: command.expectedCandidateHash,
          payloadHash: command.expectedPayloadHash,
          selectedMemberIds,
          partialAcknowledged: command.partialAcknowledged,
          createdBy: request.actorId,
        })
      },
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034')
      conflict('Concurrent package work changed this draft attempt. Retry the same operation.')
    throw error
  }
}
