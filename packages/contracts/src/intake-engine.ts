import { z } from 'zod'

export const IntakeSourceKind = z.enum([
  'WEBSITE',
  'DOCUMENT',
  'PDF',
  'BROCHURE',
  'SPREADSHEET',
  'PHOTO',
  'VIDEO',
  'MAP',
  'STRUCTURED_DATA',
  'INTERVIEW',
  'NOTE',
  'ANSWER',
])
export type IntakeSourceKind = z.infer<typeof IntakeSourceKind>

export const IntakeRunStatus = z.enum([
  'QUEUED',
  'EXTRACTING',
  'RECONCILING',
  'MAPPING',
  'VALIDATING',
  'AWAITING_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])
export type IntakeRunStatus = z.infer<typeof IntakeRunStatus>

export const IntakeSource = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
    kind: IntakeSourceKind,
    displayName: z.string().trim().min(1).max(255),
    uri: z.string().url().optional(),
    assetId: z.string().min(1).optional(),
    capturedAt: z.string().datetime({ offset: true }),
    capturedByActorId: z.string().min(1).optional(),
    consentToRecord: z.boolean().optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (!source.uri && !source.assetId && !['INTERVIEW', 'NOTE', 'ANSWER'].includes(source.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assetId'],
        message: 'This source requires a URI or stored asset reference.',
      })
    }
    if (source.kind === 'INTERVIEW' && source.consentToRecord === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consentToRecord'],
        message: 'Recording consent is owner-policy gated and cannot be enabled by this contract.',
      })
    }
  })
export type IntakeSource = z.infer<typeof IntakeSource>

export const WebsiteIntakeBounds = z
  .object({
    maxPages: z.number().int().min(1).max(100).default(25),
    maxDepth: z.number().int().min(0).max(5).default(2),
    maxBytesPerPage: z.number().int().min(1).max(10_000_000).default(2_000_000),
    allowedHosts: z.array(z.string().trim().min(1)).min(1).max(20),
    respectRobots: z.literal(true).default(true),
    publishMode: z.literal('DRAFT_ONLY').default('DRAFT_ONLY'),
  })
  .strict()
export type WebsiteIntakeBounds = z.infer<typeof WebsiteIntakeBounds>

export const IntakeEvidence = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    locator: z.string().trim().min(1).max(2_000),
    capturedAt: z.string().datetime({ offset: true }),
    normalizedHash: z.string().regex(/^[a-f0-9]{64}$/i),
    confidence: z.number().min(0).max(1),
  })
  .strict()
export type IntakeEvidence = z.infer<typeof IntakeEvidence>

export const IntakeDiscrepancy = z
  .object({
    id: z.string().min(1),
    fieldPath: z.string().trim().min(1).max(500),
    evidenceIds: z.array(z.string().min(1)).min(2).max(20),
    reason: z.enum(['CONTRADICTION', 'DATE_SENSITIVE', 'LOW_CONFIDENCE', 'MISSING_CONTEXT']),
    resolution: z.string().trim().min(1).max(5_000).optional(),
  })
  .strict()
export type IntakeDiscrepancy = z.infer<typeof IntakeDiscrepancy>

export const IntakeProposal = z
  .object({
    runId: z.string().min(1),
    status: IntakeRunStatus,
    sourceIds: z.array(z.string().min(1)).min(1).max(500),
    evidenceIds: z.array(z.string().min(1)).max(5_000).default([]),
    discrepancyIds: z.array(z.string().min(1)).max(1_000).default([]),
    packageDraftId: z.string().min(1).optional(),
    validationResultId: z.string().min(1).optional(),
    evaluationRunId: z.string().min(1).optional(),
    autoPublish: z.literal(false).default(false),
  })
  .strict()
export type IntakeProposal = z.infer<typeof IntakeProposal>

export const INTAKE_ORCHESTRATION_STAGES = [
  'DEDUPE',
  'EXTRACT',
  'RESEARCH',
  'CLASSIFY',
  'RECONCILE',
  'ASSESS_UNCERTAINTY',
  'MAP_TO_CONTENT',
  'CREATE_PROPOSAL',
  'VALIDATE',
  'REVIEW',
  'EVALUATE',
  'PREVIEW',
  'APPROVE',
  'APPLY',
] as const
export type IntakeOrchestrationStage = (typeof INTAKE_ORCHESTRATION_STAGES)[number]
