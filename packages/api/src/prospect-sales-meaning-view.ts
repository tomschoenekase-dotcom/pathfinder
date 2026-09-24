import {
  decodeSalesComponent,
  MEANING_REVIEW_SCOPE,
  nativeMeaningBinding,
  type ComponentOutput,
  type NativeMeaningDraft,
} from '@pathfinder/db'
import type {
  ClaimAnnotation,
  MeaningAssessment,
  MeaningReviewView,
  MeaningSourceClaim,
  SalesMeaningInput,
} from './prospect-meaning-contract'
import { salesMeaningInput } from './prospect-meaning-contract'

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** A read projection of existing immutable activity evidence, not another ledger. */
export function projectNativeMeaningReview(input: {
  draft: NativeMeaningDraft | undefined
  source: ComponentOutput
  /** Transient current source for display; immutable binding still uses source. */
  displaySource?: ComponentOutput
  stale: boolean
  readReviewRecorded: boolean
  reviews: { id: string; evidence: unknown; createdAt: string | Date }[]
}): MeaningReviewView | null {
  if (!input.draft) return null
  let bindingHash: string | null = null
  try {
    bindingHash = nativeMeaningBinding(input.draft, input.source).bindingHash
  } catch {
    /* Unusable retained evidence is not blessed. */
  }
  const context = obj(obj((input.displaySource ?? input.source).preparation).writerContext)
  const sources: MeaningSourceClaim[] = array(context.allowed_claims)
    .map(obj)
    .map((claim) => ({
      claim_id: str(claim.claim_id),
      category: str(claim.category),
      text: str(claim.text),
      source_id: str(claim.source_id),
      source_pointer: str(claim.source_pointer),
      ...(typeof claim.capture_sha256 === 'string'
        ? {
            capture_sha256: claim.capture_sha256,
            observed_at: str(claim.observed_at),
            retrieved_at: str(claim.retrieved_at),
            quote: str(claim.quote),
          }
        : {}),
      evidence_sha256: str(claim.evidence_sha256),
      limitation: str(claim.limitation),
      url: typeof claim.url === 'string' ? claim.url : null,
    }))
  const reviews = input.reviews.filter(
    (review) => obj(review.evidence).reviewScope === MEANING_REVIEW_SCOPE,
  )
  const latest = reviews.find(
    (review) =>
      obj(review.evidence).draftId === input.draft!.id &&
      obj(review.evidence).contentHash === input.draft!.contentHash,
  )
  const evidence = obj(latest?.evidence)
  const record = latest ? decodeSalesComponent(evidence.record) : {}
  const check = obj(record.check),
    submission = obj(record.submission),
    recorder = obj(evidence.recordedBy)
  const applicable = Boolean(
    bindingHash &&
    !input.stale &&
    evidence.bindingHash === bindingHash &&
    check.schema === 'torchiko.native-composer-meaning/1' &&
    check.SEND_AUTHORIZED === false,
  )
  const current: MeaningReviewView['current'] = latest
    ? {
        id: latest.id,
        status: str(check.status),
        bindingHash: str(evidence.bindingHash),
        recordedAt: String(latest.createdAt),
        reviewer: {
          kind: str(obj(check.reviewer).kind),
          identity: str(obj(check.reviewer).identity),
        },
        recordedBy: {
          type: str(recorder.type),
          id: str(recorder.id),
          synthetic: recorder.synthetic === true,
        },
        annotations: array(check.annotations).length
          ? (array(check.annotations) as ClaimAnnotation[])
          : (array(submission.annotations) as ClaimAnnotation[]),
        assessments: array(submission.assessments) as MeaningAssessment[],
        languageUses: array(submission.languageUses) as SalesMeaningInput['languageUses'],
        answers: array(submission.answers) as SalesMeaningInput['answers'],
        unsupportedClaims: array(submission.unsupportedClaims).map(str),
        findings: array(check.findings)
          .map(obj)
          .map((finding) => ({ code: str(finding.code), detail: str(finding.detail) })),
        unresolvedHolds: array(check.unresolvedHolds).map(str),
        operationalHolds: array(check.operationalHolds).map(str),
        claimEvidence: array(check.claimEvidence) as NonNullable<
          MeaningReviewView['current']
        >['claimEvidence'],
      }
    : null
  const candidate = salesMeaningInput.shape.annotations.safeParse(
    obj(obj(input.draft.groundingSnapshot).writerProvenance).annotations,
  )
  return {
    ...(!latest && !input.stale && bindingHash && candidate.success
      ? { candidateAnnotations: candidate.data }
      : {}),
    boundIdentity: {
      draftId: input.draft.id,
      preparationId: str(obj(input.draft.groundingSnapshot).preparationId),
      recipientKind: str(obj(context.routing).kind),
      recipientValue: str(obj(context.routing).recipient ?? obj(context.routing).url),
      sourceSnapshotHash: str(input.source.nativeSnapshotHash),
      threadId: str(obj(obj(input.source.correspondence).projection).thread_id),
      inboundId: str(obj(obj(input.source.correspondence).projection).reply_to_message_id),
    },
    bindingHash,
    stale: input.stale || !bindingHash || Boolean(latest && !applicable),
    status: !bindingHash
      ? 'UNAVAILABLE'
      : input.stale || (latest && !applicable)
        ? 'STALE'
        : !latest
          ? 'REQUIRED'
          : check.status === 'ASSESSED_NO_SEND'
            ? 'ASSESSED_NO_SEND'
            : 'BLOCKED',
    readReviewRecorded: input.readReviewRecorded && !input.stale,
    sources,
    questions: array(obj(context.relationship).questions)
      .map(obj)
      .map((question) => ({
        question_id: str(question.question_id),
        quote: str(question.quote),
        answer_claim_ids: array(question.answer_claim_ids).map(str),
      })),
    current,
    history: reviews.map((review) => {
      const row = obj(review.evidence)
      return {
        id: review.id,
        draftId: str(row.draftId),
        contentHash: str(row.contentHash),
        bindingHash: str(row.bindingHash),
        status: str(row.state),
        applicable: applicable && review.id === latest?.id,
      }
    }),
  }
}
