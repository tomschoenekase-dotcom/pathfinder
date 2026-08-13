import { z } from 'zod'

import { OffboardingExportKind } from './offboarding'

const Id = z.string().trim().min(1).max(191)
const DateTime = z.string().datetime({ offset: true })

export const FinalizeOffboardingExportInput = z
  .object({
    tenantId: Id,
    planId: Id,
    venueId: Id,
    kind: OffboardingExportKind,
    operationId: z.string().uuid(),
    expectedPlanUpdatedAt: DateTime,
  })
  .strict()

export const OffboardingExportFinalizationResult = z
  .object({
    planId: Id,
    venueId: Id,
    kind: OffboardingExportKind,
    status: z.enum(['RESERVED', 'STORED', 'SETTLED']),
    artifactRecorded: z.boolean(),
    replayed: z.boolean(),
    planStatus: z.enum(['REVIEWED', 'EXPORT_READY', 'CANCELLED']),
    remainingArtifacts: z.number().int().nonnegative(),
    planUpdatedAt: DateTime,
  })
  .strict()

export type FinalizeOffboardingExportInput = z.infer<typeof FinalizeOffboardingExportInput>
export type OffboardingExportFinalizationResult = z.infer<
  typeof OffboardingExportFinalizationResult
>

const ActionGate = z.object({ allowed: z.boolean(), reason: z.string().min(1).max(200) }).strict()

export const OffboardingExportReviewResult = z
  .object({
    planId: Id,
    status: z.literal('REVIEWED'),
    expectedUpdatedAt: DateTime,
    replayed: z.boolean(),
  })
  .strict()

export const OffboardingExportFinalizationProjection = z
  .object({
    planId: Id,
    status: z.enum(['REQUESTED', 'REVIEWED', 'EXPORT_READY', 'CANCELLED']),
    expectedUpdatedAt: DateTime,
    remainingArtifacts: z.number().int().nonnegative(),
    exportActions: z.object({ review: ActionGate, finalize: ActionGate }).strict(),
    targets: z
      .array(
        z
          .object({
            venueId: Id,
            remainingExportKinds: z.array(OffboardingExportKind).max(5),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
