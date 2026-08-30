import { z } from 'zod'

const GitRevision = z.string().regex(/^[a-f0-9]{40}$/u)
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const BoundedText = z.string().trim().min(1).max(500)

export const ReleaseEvidenceGate = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    status: z.enum(['pass', 'fail', 'blocked']),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000),
  })
  .strict()

export const ReleaseEvidenceGates = z.array(ReleaseEvidenceGate).min(1).max(100)
export const ReleaseEvidenceLimitations = z.array(BoundedText).max(50)
export const ReleaseRollbackEvidence = z
  .object({
    application: BoundedText,
    database: BoundedText,
    runbook: z.string().trim().min(1).max(300),
  })
  .strict()

export const ReleaseAssessmentEvidence = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    revision: GitRevision,
    profile: z.enum(['local', 'candidate', 'staging']),
    readiness: z.enum(['ready-local', 'ready-for-staging-review', 'ready', 'not-ready']),
    repository: z.object({ clean: z.boolean() }).strict(),
    summary: z
      .object({
        passed: z.number().int().min(0).max(1000),
        failed: z.number().int().min(0).max(1000),
        blocked: z.number().int().min(0).max(1000),
      })
      .strict(),
    gates: ReleaseEvidenceGates,
    limitations: ReleaseEvidenceLimitations,
    rollback: ReleaseRollbackEvidence,
  })
  .strict()
  .superRefine((value, context) => {
    const counts = { pass: 0, fail: 0, blocked: 0 }
    for (const gate of value.gates) counts[gate.status] += 1
    if (new Set(value.gates.map((gate) => gate.id)).size !== value.gates.length) {
      context.addIssue({ code: 'custom', path: ['gates'], message: 'Gate IDs must be unique.' })
    }
    if (
      counts.pass !== value.summary.passed ||
      counts.fail !== value.summary.failed ||
      counts.blocked !== value.summary.blocked
    ) {
      context.addIssue({
        code: 'custom',
        path: ['summary'],
        message: 'Gate summary must match the supplied gate evidence.',
      })
    }
    if (
      value.readiness !== 'not-ready' &&
      (!value.repository.clean || counts.fail > 0 || counts.blocked > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['readiness'],
        message: 'A ready assessment requires a clean repository and no failed or blocked gates.',
      })
    }
  })
export type ReleaseAssessmentEvidence = z.infer<typeof ReleaseAssessmentEvidence>

export const StagingHandoffEvidence = z
  .object({
    artifactSha256: Sha256,
    status: z.enum(['ready-for-owner-staging-integration', 'not-ready']),
    baseRevision: GitRevision,
    baseIsAncestor: z.boolean(),
    ahead: z.number().int().min(0).max(1_000_000),
    behind: z.number().int().min(0).max(1_000_000),
    changedFiles: z.number().int().min(0).max(1_000_000),
    patchSha256: Sha256,
    migrationCount: z.number().int().min(0).max(100_000),
    latestMigration: z.string().trim().min(1).max(191),
    migrationChainSha256: Sha256,
    requiredActions: z.array(BoundedText).max(50),
    retainedGates: z.array(BoundedText).max(50),
  })
  .strict()
export type StagingHandoffEvidence = z.infer<typeof StagingHandoffEvidence>

export const ReleaseEvidenceRecordFields = z
  .object({
    operationId: z.string().uuid(),
    assessment: ReleaseAssessmentEvidence,
    stagingHandoff: StagingHandoffEvidence.nullable(),
    sourceReference: z.string().trim().min(1).max(500),
  })
  .strict()

function validateHandoffConsistency(
  value: { assessment: ReleaseAssessmentEvidence; stagingHandoff: StagingHandoffEvidence | null },
  context: z.RefinementCtx,
) {
  if (
    value.stagingHandoff?.status === 'ready-for-owner-staging-integration' &&
    value.assessment.readiness !== 'ready-for-staging-review'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['stagingHandoff', 'status'],
      message: 'A staging-ready handoff requires a staging-review-ready assessment.',
    })
  }
}

export const ReleaseEvidenceRecordPayload = ReleaseEvidenceRecordFields.superRefine(
  (value, context) => {
    validateHandoffConsistency(value, context)
  },
)
export type ReleaseEvidenceRecordPayload = z.infer<typeof ReleaseEvidenceRecordPayload>

export const PlatformWorkerReleaseEvidenceReadRequest = z
  .object({ limit: z.number().int().min(1).max(25).default(5) })
  .strict()

export const PlatformWorkerReleaseEvidenceRecordRequest = ReleaseEvidenceRecordPayload

export const PlatformWorkerReleaseEvidenceRequest = z.union([
  PlatformWorkerReleaseEvidenceReadRequest.extend({ action: z.literal('read') }).strict(),
  ReleaseEvidenceRecordFields.extend({ action: z.literal('record') })
    .strict()
    .superRefine((value, context) => validateHandoffConsistency(value, context)),
])
export type PlatformWorkerReleaseEvidenceRequest = z.infer<
  typeof PlatformWorkerReleaseEvidenceRequest
>
