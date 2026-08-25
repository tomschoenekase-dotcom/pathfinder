import { z } from 'zod'

import { GUEST_CHAT_PROMPT_VERSION } from './prompt-contract'

export const GUEST_ANSWER_EVIDENCE_VERSION = 'guest-answer-evidence-v1' as const
export const GUEST_ANSWER_ATTRIBUTION_VERSION = 'guest-answer-attribution-v1' as const

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)
const sourceId = z.string().trim().min(1).max(240)

export const GuestAnswerEvidenceSourceSchema = z
  .object({
    sourceId,
    kind: z.enum([
      'VENUE_PROFILE',
      'PLACE',
      'KNOWLEDGE',
      'OPERATIONAL_UPDATE',
      'PUBLISHED_CONTENT',
    ]),
    label: z.string().trim().min(1).max(500),
    rank: z.number().int().min(0).max(100).nullable(),
    snapshot: z.string().min(2).max(30_000),
    snapshotHash: sha256,
  })
  .strict()

export const GuestAnswerEvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(GUEST_ANSWER_EVIDENCE_VERSION),
    promptContractVersion: z.literal(GUEST_CHAT_PROMPT_VERSION),
    answerHash: sha256,
    systemPromptHash: sha256,
    evidenceSetHash: sha256,
    routeConfigurationVersion: z.string().trim().min(1).max(191).nullable(),
    system: z
      .object({
        staticPart: z.string().min(1).max(100_000),
        dynamicPart: z.string().min(1).max(150_000),
      })
      .strict(),
    sources: z.array(GuestAnswerEvidenceSourceSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.sources.map((source) => source.sourceId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources'],
        message: 'Evidence source IDs must be unique',
      })
    }
  })

export const GuestAnswerClaimSupportSchema = z.enum([
  'SUPPORTED',
  'UNSUPPORTED',
  'UNCERTAIN',
  'NON_FACTUAL',
])

export const GuestAnswerClaimInputSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    text: z.string().min(1).max(2_000),
    support: GuestAnswerClaimSupportSchema,
    sourceIds: z.array(sourceId).max(20),
    rationale: z.string().trim().min(1).max(1_000),
  })
  .strict()

const evaluatorSchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(191),
    configurationVersion: z.string().trim().min(1).max(191),
    promptVersion: z.string().trim().min(1).max(191),
  })
  .strict()

export const GuestAnswerAttributionInputSchema = z
  .object({
    answer: z.string().min(1).max(10_000),
    evidence: GuestAnswerEvidenceBundleSchema,
    evaluator: evaluatorSchema,
    claims: z.array(GuestAnswerClaimInputSchema).max(100),
  })
  .strict()

export const GuestAnswerAttributionSchema = z
  .object({
    schemaVersion: z.literal(GUEST_ANSWER_ATTRIBUTION_VERSION),
    answerHash: sha256,
    evidenceSetHash: sha256,
    evaluator: evaluatorSchema,
    claims: z.array(GuestAnswerClaimInputSchema).max(100),
    metrics: z
      .object({
        claimCount: z.number().int().nonnegative(),
        supportedCount: z.number().int().nonnegative(),
        unsupportedCount: z.number().int().nonnegative(),
        uncertainCount: z.number().int().nonnegative(),
        nonFactualCount: z.number().int().nonnegative(),
        supportRate: z.number().min(0).max(1).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const counts = {
      supportedCount: value.claims.filter((claim) => claim.support === 'SUPPORTED').length,
      unsupportedCount: value.claims.filter((claim) => claim.support === 'UNSUPPORTED').length,
      uncertainCount: value.claims.filter((claim) => claim.support === 'UNCERTAIN').length,
      nonFactualCount: value.claims.filter((claim) => claim.support === 'NON_FACTUAL').length,
    }
    const factualCount = value.claims.length - counts.nonFactualCount
    const supportRate = factualCount === 0 ? null : counts.supportedCount / factualCount
    if (
      value.metrics.claimCount !== value.claims.length ||
      value.metrics.supportedCount !== counts.supportedCount ||
      value.metrics.unsupportedCount !== counts.unsupportedCount ||
      value.metrics.uncertainCount !== counts.uncertainCount ||
      value.metrics.nonFactualCount !== counts.nonFactualCount ||
      value.metrics.supportRate !== supportRate
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metrics'],
        message: 'Attribution metrics contradict the exact claim annotations',
      })
    }
  })

export type GuestAnswerEvidenceSource = z.infer<typeof GuestAnswerEvidenceSourceSchema>
export type GuestAnswerEvidenceBundle = z.infer<typeof GuestAnswerEvidenceBundleSchema>
export type GuestAnswerAttributionInput = z.infer<typeof GuestAnswerAttributionInputSchema>
export type GuestAnswerAttribution = z.infer<typeof GuestAnswerAttributionSchema>
export type GuestAnswerClaimInput = z.infer<typeof GuestAnswerClaimInputSchema>

/**
 * Validates an evaluator's bounded annotations against the exact answer and frozen source set.
 * This proves annotation integrity only. It does not decide whether a semantic judgment is true,
 * establish a pass threshold, or authorize a release.
 */
export function createGuestAnswerAttribution(
  rawInput: GuestAnswerAttributionInput,
): GuestAnswerAttribution {
  const input = GuestAnswerAttributionInputSchema.parse(rawInput)
  const sourceIds = new Set(input.evidence.sources.map((source) => source.sourceId))
  let priorEnd = 0

  input.claims.forEach((claim, index) => {
    if (claim.end <= claim.start || claim.end > input.answer.length) {
      throw new Error(`Claim ${index + 1} has an invalid response span`)
    }
    if (claim.start < priorEnd) {
      throw new Error(`Claim ${index + 1} overlaps a prior response span`)
    }
    if (input.answer.slice(claim.start, claim.end) !== claim.text) {
      throw new Error(`Claim ${index + 1} text does not match the exact response span`)
    }
    if (new Set(claim.sourceIds).size !== claim.sourceIds.length) {
      throw new Error(`Claim ${index + 1} repeats an evidence source`)
    }
    if (claim.sourceIds.some((id) => !sourceIds.has(id))) {
      throw new Error(`Claim ${index + 1} references evidence outside the frozen source set`)
    }
    if (claim.support === 'SUPPORTED' && claim.sourceIds.length === 0) {
      throw new Error(`Supported claim ${index + 1} requires at least one evidence source`)
    }
    if (claim.support === 'NON_FACTUAL' && claim.sourceIds.length > 0) {
      throw new Error(`Non-factual claim ${index + 1} cannot cite an evidence source`)
    }
    priorEnd = claim.end
  })

  const factualClaims = input.claims.filter((claim) => claim.support !== 'NON_FACTUAL')
  const supportedCount = input.claims.filter((claim) => claim.support === 'SUPPORTED').length
  return GuestAnswerAttributionSchema.parse({
    schemaVersion: GUEST_ANSWER_ATTRIBUTION_VERSION,
    answerHash: input.evidence.answerHash,
    evidenceSetHash: input.evidence.evidenceSetHash,
    evaluator: input.evaluator,
    claims: input.claims,
    metrics: {
      claimCount: input.claims.length,
      supportedCount,
      unsupportedCount: input.claims.filter((claim) => claim.support === 'UNSUPPORTED').length,
      uncertainCount: input.claims.filter((claim) => claim.support === 'UNCERTAIN').length,
      nonFactualCount: input.claims.filter((claim) => claim.support === 'NON_FACTUAL').length,
      supportRate: factualClaims.length === 0 ? null : supportedCount / factualClaims.length,
    },
  })
}
