import { z } from 'zod'

import {
  GuestAnswerAttributionSchema,
  type GuestAnswerAttribution,
  type GuestAnswerClaimInput,
} from './guest-answer-attribution'

export const GUEST_ANSWER_ATTRIBUTION_AGREEMENT_VERSION =
  'guest-answer-attribution-agreement-v1' as const

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)

export const GuestAnswerAttributionAgreementRecordSchema = z
  .object({
    attributionId: z.string().uuid(),
    guestChatTurnId: z.string().uuid(),
    reviewerId: z.string().trim().min(1).max(191),
    answerHash: sha256,
    evidenceSetHash: sha256,
    createdAt: z.coerce.date(),
    attribution: GuestAnswerAttributionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.answerHash !== value.attribution.answerHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answerHash'],
        message: 'Stored answer hash does not match the attribution snapshot',
      })
    }
    if (value.evidenceSetHash !== value.attribution.evidenceSetHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidenceSetHash'],
        message: 'Stored evidence-set hash does not match the attribution snapshot',
      })
    }
  })

export type GuestAnswerAttributionAgreementRecord = z.infer<
  typeof GuestAnswerAttributionAgreementRecordSchema
>

export type GuestAnswerAttributionAgreementMetrics = {
  annotatedCharacterUnion: number
  bothAnnotatedCharacters: number
  coverageOverlapRate: number | null
  matchingSupportCharacters: number
  supportAgreementRate: number | null
  bothSupportedCharacters: number
  matchingSourceCharacters: number
  sourceAgreementRate: number | null
}

export type GuestAnswerAttributionAgreementReport = {
  schemaVersion: typeof GUEST_ANSWER_ATTRIBUTION_AGREEMENT_VERSION
  inputRecordCount: number
  selectedRecordCount: number
  turnCount: number
  identityGroupCount: number
  comparableGroupCount: number
  independentPairCount: number
  distinctReviewerCount: number
  exclusions: {
    repeatedReviewerRecordCount: number
    singleReviewerGroupCount: number
    identityConflictTurnCount: number
  }
  metrics: GuestAnswerAttributionAgreementMetrics
  groups: Array<{
    guestChatTurnId: string
    answerHash: string
    evidenceSetHash: string
    selectedReviewCount: number
    independentPairCount: number
    metrics: GuestAnswerAttributionAgreementMetrics
  }>
}

type ClaimAtCharacter = Pick<GuestAnswerClaimInput, 'support' | 'sourceIds'> | undefined

function emptyMetrics(): GuestAnswerAttributionAgreementMetrics {
  return {
    annotatedCharacterUnion: 0,
    bothAnnotatedCharacters: 0,
    coverageOverlapRate: null,
    matchingSupportCharacters: 0,
    supportAgreementRate: null,
    bothSupportedCharacters: 0,
    matchingSourceCharacters: 0,
    sourceAgreementRate: null,
  }
}

function finalizeMetrics(
  metrics: Omit<
    GuestAnswerAttributionAgreementMetrics,
    'coverageOverlapRate' | 'supportAgreementRate' | 'sourceAgreementRate'
  >,
): GuestAnswerAttributionAgreementMetrics {
  return {
    ...metrics,
    coverageOverlapRate:
      metrics.annotatedCharacterUnion === 0
        ? null
        : metrics.bothAnnotatedCharacters / metrics.annotatedCharacterUnion,
    supportAgreementRate:
      metrics.bothAnnotatedCharacters === 0
        ? null
        : metrics.matchingSupportCharacters / metrics.bothAnnotatedCharacters,
    sourceAgreementRate:
      metrics.bothSupportedCharacters === 0
        ? null
        : metrics.matchingSourceCharacters / metrics.bothSupportedCharacters,
  }
}

function claimMap(attribution: GuestAnswerAttribution): ClaimAtCharacter[] {
  const length = attribution.claims.reduce((maximum, claim) => Math.max(maximum, claim.end), 0)
  const map = new Array<ClaimAtCharacter>(length)
  for (const claim of attribution.claims) {
    for (let index = claim.start; index < claim.end; index += 1) map[index] = claim
  }
  return map
}

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((sourceId) => rightSet.has(sourceId))
}

function comparePair(
  left: ClaimAtCharacter[],
  right: ClaimAtCharacter[],
): GuestAnswerAttributionAgreementMetrics {
  const totals = {
    annotatedCharacterUnion: 0,
    bothAnnotatedCharacters: 0,
    matchingSupportCharacters: 0,
    bothSupportedCharacters: 0,
    matchingSourceCharacters: 0,
  }
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftClaim = left[index]
    const rightClaim = right[index]
    if (leftClaim || rightClaim) totals.annotatedCharacterUnion += 1
    if (!leftClaim || !rightClaim) continue
    totals.bothAnnotatedCharacters += 1
    if (leftClaim.support === rightClaim.support) totals.matchingSupportCharacters += 1
    if (leftClaim.support !== 'SUPPORTED' || rightClaim.support !== 'SUPPORTED') continue
    totals.bothSupportedCharacters += 1
    if (sameSources(leftClaim.sourceIds, rightClaim.sourceIds)) {
      totals.matchingSourceCharacters += 1
    }
  }
  return finalizeMetrics(totals)
}

function addMetrics(
  target: GuestAnswerAttributionAgreementMetrics,
  source: GuestAnswerAttributionAgreementMetrics,
): void {
  target.annotatedCharacterUnion += source.annotatedCharacterUnion
  target.bothAnnotatedCharacters += source.bothAnnotatedCharacters
  target.matchingSupportCharacters += source.matchingSupportCharacters
  target.bothSupportedCharacters += source.bothSupportedCharacters
  target.matchingSourceCharacters += source.matchingSourceCharacters
}

function newestFirst(
  left: GuestAnswerAttributionAgreementRecord,
  right: GuestAnswerAttributionAgreementRecord,
): number {
  const time = right.createdAt.getTime() - left.createdAt.getTime()
  return time || right.attributionId.localeCompare(left.attributionId)
}

/**
 * Computes descriptive, segmentation-independent agreement from immutable human reviews.
 * It establishes neither reviewer correctness nor a quality/release threshold.
 */
export function analyzeGuestAnswerAttributionAgreement(
  rawRecords: readonly GuestAnswerAttributionAgreementRecord[],
): GuestAnswerAttributionAgreementReport {
  const records = rawRecords.map((record) =>
    GuestAnswerAttributionAgreementRecordSchema.parse(record),
  )
  const turnIdentities = new Map<string, Set<string>>()
  const groups = new Map<string, GuestAnswerAttributionAgreementRecord[]>()
  for (const record of records) {
    const identity = `${record.answerHash}:${record.evidenceSetHash}`
    const identities = turnIdentities.get(record.guestChatTurnId) ?? new Set<string>()
    identities.add(identity)
    turnIdentities.set(record.guestChatTurnId, identities)
    const key = `${record.guestChatTurnId}:${identity}`
    groups.set(key, [...(groups.get(key) ?? []), record])
  }

  let repeatedReviewerRecordCount = 0
  let singleReviewerGroupCount = 0
  let selectedRecordCount = 0
  const distinctReviewers = new Set<string>()
  const aggregate = emptyMetrics()
  const reportGroups: GuestAnswerAttributionAgreementReport['groups'] = []

  for (const groupedRecords of groups.values()) {
    const selectedByReviewer = new Map<string, GuestAnswerAttributionAgreementRecord>()
    for (const record of [...groupedRecords].sort(newestFirst)) {
      if (selectedByReviewer.has(record.reviewerId)) {
        repeatedReviewerRecordCount += 1
        continue
      }
      selectedByReviewer.set(record.reviewerId, record)
      distinctReviewers.add(record.reviewerId)
    }
    const selected = [...selectedByReviewer.values()].sort((left, right) =>
      left.reviewerId.localeCompare(right.reviewerId),
    )
    selectedRecordCount += selected.length
    if (selected.length < 2) singleReviewerGroupCount += 1

    const maps = new Map(
      selected.map((record) => [record.attributionId, claimMap(record.attribution)]),
    )
    const groupMetrics = emptyMetrics()
    let pairCount = 0
    for (let leftIndex = 0; leftIndex < selected.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < selected.length; rightIndex += 1) {
        const left = selected[leftIndex]!
        const right = selected[rightIndex]!
        const pairMetrics = comparePair(
          maps.get(left.attributionId)!,
          maps.get(right.attributionId)!,
        )
        addMetrics(groupMetrics, pairMetrics)
        addMetrics(aggregate, pairMetrics)
        pairCount += 1
      }
    }
    const first = selected[0] ?? groupedRecords[0]!
    reportGroups.push({
      guestChatTurnId: first.guestChatTurnId,
      answerHash: first.answerHash,
      evidenceSetHash: first.evidenceSetHash,
      selectedReviewCount: selected.length,
      independentPairCount: pairCount,
      metrics: finalizeMetrics(groupMetrics),
    })
  }

  reportGroups.sort((left, right) =>
    `${left.guestChatTurnId}:${left.answerHash}:${left.evidenceSetHash}`.localeCompare(
      `${right.guestChatTurnId}:${right.answerHash}:${right.evidenceSetHash}`,
    ),
  )
  return {
    schemaVersion: GUEST_ANSWER_ATTRIBUTION_AGREEMENT_VERSION,
    inputRecordCount: records.length,
    selectedRecordCount,
    turnCount: turnIdentities.size,
    identityGroupCount: reportGroups.length,
    comparableGroupCount: reportGroups.filter((group) => group.independentPairCount > 0).length,
    independentPairCount: reportGroups.reduce(
      (total, group) => total + group.independentPairCount,
      0,
    ),
    distinctReviewerCount: distinctReviewers.size,
    exclusions: {
      repeatedReviewerRecordCount,
      singleReviewerGroupCount,
      identityConflictTurnCount: [...turnIdentities.values()].filter(
        (identities) => identities.size > 1,
      ).length,
    },
    metrics: finalizeMetrics(aggregate),
    groups: reportGroups,
  }
}
