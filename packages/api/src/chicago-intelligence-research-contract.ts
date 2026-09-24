import { z } from 'zod'
import { chicagoDirectoryInput, chicagoEvidence } from './chicago-intelligence-contract'

const id = z.string().trim().min(1).max(191)
const gapKey = z.string().trim().min(1).max(100)
const reason = z.string().trim().min(12).max(2000)
export const chicagoResearchPreviewInput = z
  .object({
    filters: chicagoDirectoryInput
      .omit({ page: true, pageSize: true, sorts: true, lifecycle: true })
      .optional(),
    limit: z.number().int().min(1).max(10).default(10),
  })
  .strict()
export const chicagoResearchQueueInput = z
  .object({
    idempotencyKey: id,
    selections: z
      .array(
        z
          .object({
            venueId: id,
            expectedVersion: z.number().int().min(1),
            gapKeys: z
              .array(gapKey)
              .min(1)
              .max(10)
              .refine((keys) => new Set(keys).size === keys.length, 'Gap keys must be distinct'),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .refine(
        (items) => new Set(items.map((item) => item.venueId)).size === items.length,
        'Venue IDs must be distinct',
      ),
  })
  .strict()
export const chicagoResearchClaimInput = z
  .object({
    idempotencyKey: id,
    venueId: id,
    jobId: id,
    queueReceiptId: id,
    leaseSeconds: z.number().int().min(60).max(1800).default(900),
  })
  .strict()
const lease = { idempotencyKey: id, venueId: id, jobId: id, claimToken: z.string().uuid() }
export const chicagoResearchCompleteInput = z
  .object({
    ...lease,
    outcome: z.enum(['RESEARCHED', 'NEEDS_REVIEW', 'BLOCKED', 'CAP_REACHED']),
    summary: reason,
    evidence: z.array(chicagoEvidence).max(10),
    unknowns: z
      .array(z.object({ gapKey, reason }).strict())
      .max(10)
      .refine(
        (items) => new Set(items.map((item) => item.gapKey)).size === items.length,
        'Unknown gap keys must be distinct',
      ),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.outcome === 'RESEARCHED' && (!input.evidence.length || input.unknowns.length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message:
          'A researched result requires exact sources and no unresolved requested gaps; use an incomplete outcome for unknowns',
      })
    }
    if (input.outcome !== 'RESEARCHED' && !input.unknowns.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unknowns'],
        message:
          'Incomplete research must preserve at least one unresolved requested gap with its reason',
      })
    }
  })
export const chicagoResearchReleaseInput = z.object({ ...lease, reason }).strict()

export type ChicagoResearchGap = { key: string; reason: string; priority: number }
export type ChicagoResearchCandidate = {
  venueId: string
  organizationId: string
  name: string
  city: string | null
  state: string | null
  category: string | null
  expectedVersion: number
  stale: boolean
  gaps: ChicagoResearchGap[]
  priority: number
  coverageCell: {
    city: string | null
    state: string | null
    category: string | null
    venues: number
    needingResearch: number
  }
}
export type ChicagoResearchPreview = {
  candidates: ChicagoResearchCandidate[]
  scanned: number
  eligible: number
  coverageCells: number
  truncated: boolean
  queueCreated: false
}
export type ChicagoResearchQueuedJob = {
  jobId: string
  venueId: string
  organizationId: string
  expectedVersion: number
  gaps: ChicagoResearchGap[]
  status: string
  deduplicated: boolean
  generation: number
  requestReceiptId: string
}
export type ChicagoResearchReceipt<T> = { receiptId: string; replayed: boolean } & T
export type ChicagoResearchQueueResult = ChicagoResearchReceipt<{
  schema: string
  jobs: ChicagoResearchQueuedJob[]
  outreachAuthorized: false
}>
export type ChicagoResearchClaimResult = ChicagoResearchReceipt<{
  jobId: string
  venueId: string
  claimToken: string
  attemptId: string
  leaseExpiresAt: string
  gaps: ChicagoResearchGap[]
  outreachAuthorized: false
}>
export type ChicagoResearchCompleteResult = ChicagoResearchReceipt<{
  jobId: string
  venueId: string
  attemptId: string
  status: string
  evidenceIds: string[]
  unknowns: { gapKey: string; reason: string }[]
  canonicalFieldsApplied: false
  outreachAuthorized: false
}>
export type ChicagoResearchReleaseResult = ChicagoResearchReceipt<{
  jobId: string
  venueId: string
  attemptId: string
  status: string
  expired: boolean
  outreachAuthorized: false
}>
