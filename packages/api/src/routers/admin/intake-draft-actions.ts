import { TRPCError } from '@trpc/server'
import type { z } from 'zod'

import { logger } from '@pathfinder/config'
import { db as database } from '@pathfinder/db'

import { publicTRPCError } from '../../core'
import { intakeReviewedDraftFinalizer } from '../../lib/admin-reviewed-draft-finalizers'
import {
  buildIntakeVenuePackageCandidate,
  isExactIntakeCandidateHandoff,
  intakeCandidateDraftKey,
} from '../../lib/intake-venue-package-candidate'
import {
  buildWebsiteVenuePackageMappingCandidate,
  WebsiteMappingError,
  WebsiteMappingSelections,
  websiteMappingDraftKey,
} from '../../lib/intake-website-mapping'
import { createVenuePackageDraftService } from '../venue-package'

type Database = typeof database
type MappingSelections = z.infer<typeof WebsiteMappingSelections>

export async function createWebsiteMappingDraftForAdmin(input: {
  db: Database
  actorId: string
  tenantId: string
  venueId: string
  runId: string
  receiptId: string
  expectedResearchHash: string
  expectedMappingReviewHash: string
  expectedCandidateHash: string
  selections: MappingSelections
}) {
  let candidate
  try {
    candidate = await buildWebsiteVenuePackageMappingCandidate({
      db: input.db,
      tenantId: input.tenantId,
      venueId: input.venueId,
      runId: input.runId,
      receiptId: input.receiptId,
      expectedResearchHash: input.expectedResearchHash,
      selections: input.selections,
      allowExistingHandoff: true,
    })
  } catch (error) {
    if (error instanceof WebsiteMappingError) {
      throw new TRPCError({
        code:
          error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : error.code === 'INVALID_INPUT'
              ? 'BAD_REQUEST'
              : error.code === 'CONFLICT'
                ? 'CONFLICT'
                : 'PRECONDITION_FAILED',
        message: error.message,
      })
    }
    throw error
  }
  if (
    candidate.mappingReviewHash !== input.expectedMappingReviewHash ||
    candidate.candidateHash !== input.expectedCandidateHash
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Website mapping evidence changed; preview it again before creating a draft.',
    })
  }
  const draftKey = websiteMappingDraftKey({
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
    mappingReviewHash: candidate.mappingReviewHash,
    actorId: input.actorId,
  })
  const existingHandoff = await isExactIntakeCandidateHandoff({
    db: input.db,
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
    draftKey,
    candidateHash: candidate.candidateHash,
    actorId: input.actorId,
  })
  if (existingHandoff === 'MISMATCH') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This website intake is already linked to a different package draft.',
    })
  }
  const baseFinalizer = intakeReviewedDraftFinalizer({
    actorId: input.actorId,
    intakeRunId: input.runId,
  })
  const mappingReviewHash = candidate.mappingReviewHash
  const candidateHash = candidate.candidateHash
  try {
    return await createVenuePackageDraftService({
      db: input.db,
      tenantId: input.tenantId,
      actor: { type: 'HUMAN', id: input.actorId, role: 'PLATFORM_ADMIN' },
      input: { venueId: input.venueId, draftKey, payload: candidate.payload },
      finalizer: async (finalizerInput) => {
        const current = await buildWebsiteVenuePackageMappingCandidate({
          db: finalizerInput.tx,
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: input.runId,
          receiptId: input.receiptId,
          expectedResearchHash: input.expectedResearchHash,
          selections: input.selections,
          allowExistingHandoff: true,
        })
        if (
          current.mappingReviewHash !== mappingReviewHash ||
          current.candidateHash !== candidateHash
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Website mapping evidence changed during draft creation.',
          })
        }
        return baseFinalizer(finalizerInput)
      },
    })
  } catch (error) {
    const diagnostic = {
      action: 'intake.website-mapping-draft.rejected',
      tenantId: input.tenantId,
      venueId: input.venueId,
      runId: input.runId,
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorCode:
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null,
      error:
        error instanceof Error
          ? error.message.slice(0, 500)
          : 'Unknown website mapping DRAFT failure',
    }
    if (error instanceof TRPCError) {
      logger.warn(diagnostic)
      throw publicTRPCError({ code: error.code, message: error.message })
    }
    logger.error(diagnostic)
    throw error
  }
}

export async function createIntakeCandidateDraftForAdmin(input: {
  db: Database
  actorId: string
  tenantId: string
  venueId: string
  runId: string
  expectedCandidateHash: string
}) {
  const candidate = await buildIntakeVenuePackageCandidate({
    db: input.db,
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
    allowExistingHandoff: true,
  })
  if (!candidate.ready || !candidate.payload || !candidate.candidateHash) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The reviewed intake source is not ready for a package candidate.',
    })
  }
  if (candidate.candidateHash !== input.expectedCandidateHash) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The reviewed intake candidate changed. Reload it before creating a draft.',
    })
  }
  const canonicalHash = candidate.candidateHash
  const draftKey = intakeCandidateDraftKey({
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
    candidateHash: canonicalHash,
    actorId: input.actorId,
  })
  const existingHandoff = await isExactIntakeCandidateHandoff({
    db: input.db,
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
    draftKey,
    candidateHash: canonicalHash,
    actorId: input.actorId,
  })
  if (existingHandoff === 'MISMATCH') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This intake proposal is already linked to a different package draft.',
    })
  }
  const baseFinalizer = intakeReviewedDraftFinalizer({
    actorId: input.actorId,
    intakeRunId: input.runId,
  })
  return createVenuePackageDraftService({
    db: input.db,
    tenantId: input.tenantId,
    actor: { type: 'HUMAN', id: input.actorId, role: 'PLATFORM_ADMIN' },
    input: { venueId: input.venueId, draftKey, payload: candidate.payload },
    finalizer: async (finalizerInput) => {
      const current = await buildIntakeVenuePackageCandidate({
        db: finalizerInput.tx,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        allowExistingHandoff: true,
      })
      if (!current.ready || !current.payload || current.candidateHash !== canonicalHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'The reviewed intake candidate changed during draft creation.',
        })
      }
      return baseFinalizer(finalizerInput)
    },
  })
}
