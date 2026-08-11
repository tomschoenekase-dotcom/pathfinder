import { z } from 'zod'

export const OffboardingStatus = z.enum([
  'REQUESTED',
  'REVIEWED',
  'REVOCATION_SCHEDULED',
  'REVOKING',
  'EXPORT_READY',
  'COMPLETED',
  'CANCELLED',
])
export type OffboardingStatus = z.infer<typeof OffboardingStatus>

export const OffboardingRevocationTarget = z.enum([
  'GUEST_LINKS',
  'WIDGETS',
  'PARTNER_API_KEYS',
  'MCP_CREDENTIALS',
  'BACKGROUND_JOBS',
  'AGENT_IDENTITIES',
  'CLIENT_ACCESS',
  'OPERATOR_IMPERSONATION',
])
export type OffboardingRevocationTarget = z.infer<typeof OffboardingRevocationTarget>

export const OffboardingExportKind = z.enum([
  'APPROVED_CONTENT',
  'CONTENT_HISTORY',
  'VENUE_PACKAGES',
  'CONFIGURATION',
  'AUDIT_HISTORY',
])
export type OffboardingExportKind = z.infer<typeof OffboardingExportKind>

export const OffboardingStep = z
  .object({
    target: OffboardingRevocationTarget,
    status: z.enum(['PENDING', 'COMPLETE', 'FAILED', 'SKIPPED']),
    completedAt: z.string().datetime({ offset: true }).optional(),
    evidenceId: z.string().min(1).optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.status === 'COMPLETE' && (!step.completedAt || !step.evidenceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceId'],
        message: 'Completed revocations require timestamped evidence.',
      })
    }
  })
export type OffboardingStep = z.infer<typeof OffboardingStep>

export const OffboardingExport = z
  .object({
    kind: OffboardingExportKind,
    artifactId: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
export type OffboardingExport = z.infer<typeof OffboardingExport>

export const OffboardingPlan = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    venueIds: z.array(z.string().min(1)).min(1),
    status: OffboardingStatus,
    revocations: z.array(OffboardingStep).min(1),
    exports: z.array(OffboardingExport).default([]),
    requestedAt: z.string().datetime({ offset: true }),
    effectiveAt: z.string().datetime({ offset: true }).optional(),
    deletionRequested: z.literal(false).default(false),
  })
  .strict()
export type OffboardingPlan = z.infer<typeof OffboardingPlan>

export function isOffboardingComplete(plan: OffboardingPlan): boolean {
  if (plan.status !== 'COMPLETED') return false
  return plan.revocations.every((step) => step.status === 'COMPLETE' || step.status === 'SKIPPED')
}
