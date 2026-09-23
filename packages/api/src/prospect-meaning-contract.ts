import { z } from 'zod'

const id = z.string().min(1).max(191)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const reason = z.string().min(12).max(2000)
export const claimCategories = [
  'SOURCE FACT',
  'RELATIONSHIP FACT',
  'TASK CONSTRAINT',
  'SALES HYPOTHESIS',
  'APPROVED REUSABLE LANGUAGE',
  'NONFACTUAL',
  'UNSUPPORTED ADDITION',
] as const

/** Offsets use Unicode code points, as in the original Python Composer contract. */
export const claimAnnotation = z
  .object({
    annotation_id: id,
    section: z.enum(['subject', 'body']),
    start: z.number().int().min(0).max(12000),
    end: z.number().int().min(1).max(12000),
    quote: z.string().min(1).max(12000),
    category: z.enum(claimCategories),
    claim_ids: z.array(id).max(12),
    reason,
    answers: z.array(id).max(5),
  })
  .strict()
const languageUse = z
  .object({
    entry_id: id,
    entry_sha256: hash,
    approval_source_sha256: hash,
    section: z.enum(['subject', 'body']),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
    quote: z.string().min(1).max(12000),
    mode: z.enum(['exact', 'adapted']),
    edits: z
      .array(
        z
          .object({ from: z.string().max(2000), to: z.string().max(2000), supported_by: id })
          .strict(),
      )
      .max(8),
    rule_review: z
      .array(
        z
          .object({
            kind: z.enum(['must_preserve', 'may_adapt', 'must_not_infer']),
            rule: z.string().min(1).max(2000),
            verdict: z.literal('within-rule'),
            reason,
          })
          .strict(),
      )
      .max(24),
  })
  .strict()
export const meaningAssessment = z
  .object({
    annotation_id: id,
    verdict: z.enum(['supported', 'hypothetical', 'nonfactual', 'unsupported', 'uncertain']),
    reason,
  })
  .strict()
export const salesMeaningInput = z
  .object({
    venueId: id,
    draftId: id,
    contentHash: hash,
    expectedSnapshotHash: hash,
    expectedBindingHash: hash,
    expectedMeaningReviewId: id.nullable(),
    annotations: z.array(claimAnnotation).min(1).max(80),
    languageUses: z.array(languageUse).max(2),
    reviewer: z
      .object({ kind: z.enum(['model', 'human']), identity: z.string().trim().min(1).max(200) })
      .strict(),
    assessments: z.array(meaningAssessment).max(80),
    answers: z
      .array(
        z
          .object({
            question_id: id,
            verdict: z.enum(['answers', 'unresolved']),
            quote: z.string().max(12000),
            reason,
          })
          .strict(),
      )
      .max(5),
    unsupportedClaims: z.array(z.string().min(1).max(1000)).max(80),
  })
  .strict()

export type ClaimAnnotation = z.infer<typeof claimAnnotation>
export type MeaningAssessment = z.infer<typeof meaningAssessment>
export type SalesMeaningInput = z.infer<typeof salesMeaningInput>
export type MeaningSubmission = Pick<
  SalesMeaningInput,
  | 'draftId'
  | 'contentHash'
  | 'annotations'
  | 'languageUses'
  | 'reviewer'
  | 'assessments'
  | 'answers'
  | 'unsupportedClaims'
> & {
  bindingHash: string
  preparationId: string
}
export interface MeaningSourceClaim {
  capture_sha256?: string
  observed_at?: string
  retrieved_at?: string
  quote?: string
  claim_id: string
  category: string
  text: string
  source_id: string
  source_pointer: string
  evidence_sha256: string
  limitation: string
  url: string | null
}
export interface MeaningReviewView {
  /** Imported exact annotations awaiting assessment, not a recorded review. */
  candidateAnnotations?: ClaimAnnotation[]
  boundIdentity: {
    draftId: string
    preparationId: string
    recipientKind: string
    recipientValue: string
    sourceSnapshotHash: string
    threadId: string
    inboundId: string
  }
  bindingHash: string | null
  stale: boolean
  status: 'REQUIRED' | 'BLOCKED' | 'ASSESSED_NO_SEND' | 'STALE' | 'UNAVAILABLE'
  readReviewRecorded: boolean
  sources: MeaningSourceClaim[]
  questions: { question_id: string; quote: string; answer_claim_ids: string[] }[]
  current: {
    id: string
    status: string
    bindingHash: string
    recordedAt: string
    reviewer: { kind: string; identity: string }
    recordedBy: { type: string; id: string; synthetic: boolean }
    annotations: ClaimAnnotation[]
    assessments: MeaningAssessment[]
    languageUses: SalesMeaningInput['languageUses']
    answers: SalesMeaningInput['answers']
    unsupportedClaims: string[]
    findings: { code: string; detail: string }[]
    unresolvedHolds: string[]
    operationalHolds: string[]
    claimEvidence: {
      annotation: ClaimAnnotation
      sources: MeaningSourceClaim[]
      unknownClaimIds: string[]
    }[]
  } | null
  history: {
    id: string
    draftId: string
    contentHash: string
    bindingHash: string
    status: string
    applicable: boolean
  }[]
}
