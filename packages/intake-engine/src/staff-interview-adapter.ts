import { createHash } from 'node:crypto'

import {
  STAFF_INTERVIEW_CONSENT_TEXT,
  STAFF_INTERVIEW_QUESTION_SETS,
  StaffInterviewSubmission,
  type StaffInterviewPrivacy,
  type StaffInterviewRole,
  type StaffInterviewSubmission as StaffInterviewSubmissionType,
} from '@pathfinder/contracts/staff-interview'

import type { BlockedAdapterResult, ConfiguredAdapterResult, IntakeSourceAdapter } from './index'

export type StaffInterviewPublicAnswer = {
  questionId: string
  fieldPath: string
  text: string
  evidenceId: string
  confidence: number
  privacy: 'PUBLIC_CANDIDATE'
}

export type StaffInterviewCandidate = {
  schemaVersion: 1
  role: StaffInterviewRole
  consentToUseText: typeof STAFF_INTERVIEW_CONSENT_TEXT
  publicAnswers: readonly StaffInterviewPublicAnswer[]
  withheld: readonly {
    questionId: string
    privacy: StaffInterviewPrivacy
    reason: 'INTERNAL_CONTEXT' | 'PRIVATE' | 'REDACTED'
    evidenceId: string | null
  }[]
  uncertainties: readonly { questionId: string; confidence: number }[]
  missingInformation: readonly {
    questionId: string
    reason: 'NOT_ANSWERED' | 'SKIPPED' | 'REDACTED'
  }[]
}

export class StaffInterviewAdapterError extends Error {
  constructor(
    readonly code: 'INVALID_INTERVIEW' | 'RECORDING_NOT_ALLOWED',
    message: string,
  ) {
    super(message)
    this.name = 'StaffInterviewAdapterError'
  }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedAnswer(value: string) {
  return value.trim().replace(/\s+/gu, ' ')
}

function effectivePrivacy(
  defaultPrivacy: StaffInterviewPrivacy,
  answerPrivacy: StaffInterviewPrivacy,
) {
  const rank: Record<StaffInterviewPrivacy, number> = {
    PUBLIC_CANDIDATE: 0,
    INTERNAL_CONTEXT: 1,
    PRIVATE: 2,
  }
  return rank[answerPrivacy] >= rank[defaultPrivacy] ? answerPrivacy : defaultPrivacy
}

function blocked(sourceId: string): BlockedAdapterResult {
  return {
    status: 'BLOCKED',
    sourceId,
    sourceKind: 'INTERVIEW',
    reason: 'CONSENT_REQUIRED',
    missingInformation: ['Accept the consent-to-use text before using interview answers.'],
    evidence: [],
    discrepancies: [],
    claims: [],
    costUnits: 0,
  }
}

export function createStaffInterviewSourceAdapter(options: {
  loadSubmission: (
    sourceId: string,
  ) => StaffInterviewSubmissionType | Promise<StaffInterviewSubmissionType>
}): IntakeSourceAdapter<StaffInterviewCandidate, 'INTERVIEW'> {
  return {
    kind: 'INTERVIEW',
    async extract(source) {
      if (source.consentToRecord !== undefined) {
        throw new StaffInterviewAdapterError(
          'RECORDING_NOT_ALLOWED',
          'Staff interview intake accepts written answers only and has no recording capability.',
        )
      }
      const parsed = StaffInterviewSubmission.safeParse(await options.loadSubmission(source.id))
      if (!parsed.success) {
        const recordingAttempt = parsed.error.issues.some((issue) =>
          [
            'recording',
            'recordingEnabled',
            'audio',
            'audioAssetId',
            'video',
            'videoAssetId',
          ].includes(String(issue.path[0])),
        )
        throw new StaffInterviewAdapterError(
          recordingAttempt ? 'RECORDING_NOT_ALLOWED' : 'INVALID_INTERVIEW',
          recordingAttempt
            ? 'Staff interview intake accepts written answers only and has no recording capability.'
            : parsed.error.issues.map((issue) => issue.message).join('; '),
        )
      }
      const submission = parsed.data
      if (!submission.consentToUse) return blocked(source.id)

      const questions = STAFF_INTERVIEW_QUESTION_SETS[submission.role]
      const byQuestion = new Map(questions.map((question) => [question.id, question]))
      const answers = new Map(submission.answers.map((answer) => [answer.questionId, answer]))
      const unknown = submission.answers.find((answer) => !byQuestion.has(answer.questionId))
      if (unknown) {
        throw new StaffInterviewAdapterError(
          'INVALID_INTERVIEW',
          `Question ${unknown.questionId} does not belong to the ${submission.role} interview.`,
        )
      }

      const evidence: ConfiguredAdapterResult<StaffInterviewCandidate>['evidence'][number][] = []
      const claims: ConfiguredAdapterResult<StaffInterviewCandidate>['claims'][number][] = []
      const publicAnswers: StaffInterviewPublicAnswer[] = []
      const withheld: StaffInterviewCandidate['withheld'][number][] = []
      const uncertainties: StaffInterviewCandidate['uncertainties'][number][] = []
      const missingInformation: StaffInterviewCandidate['missingInformation'][number][] = []

      for (const question of questions) {
        const answer = answers.get(question.id)
        if (!answer) {
          if (question.required) {
            missingInformation.push({ questionId: question.id, reason: 'NOT_ANSWERED' })
          }
          continue
        }
        if (answer.skipped) {
          missingInformation.push({ questionId: question.id, reason: 'SKIPPED' })
          continue
        }
        const privacy = effectivePrivacy(question.defaultPrivacy, answer.privacy)
        if (answer.redacted) {
          withheld.push({
            questionId: question.id,
            privacy,
            reason: 'REDACTED',
            evidenceId: null,
          })
          missingInformation.push({ questionId: question.id, reason: 'REDACTED' })
          continue
        }
        const text = normalizedAnswer(answer.text ?? '')
        const evidenceHash = hash(`${source.id}:${question.id}:${privacy}:${text}`)
        const evidenceId = `evidence_${evidenceHash.slice(0, 24)}`
        evidence.push({
          id: evidenceId,
          sourceId: source.id,
          locator: `interview://${source.id}/${question.id}`,
          capturedAt: source.capturedAt,
          normalizedHash: evidenceHash,
          confidence: answer.confidence,
        })
        if (answer.uncertain || answer.confidence < 0.7) {
          uncertainties.push({ questionId: question.id, confidence: answer.confidence })
        }
        if (privacy === 'PUBLIC_CANDIDATE') {
          publicAnswers.push({
            questionId: question.id,
            fieldPath: question.fieldPath,
            text,
            evidenceId,
            confidence: answer.confidence,
            privacy: 'PUBLIC_CANDIDATE',
          })
          claims.push({
            fieldPath: question.fieldPath,
            value: text,
            evidenceId,
          })
        } else {
          withheld.push({
            questionId: question.id,
            privacy,
            reason: privacy,
            evidenceId,
          })
        }
      }
      const candidate: StaffInterviewCandidate = {
        schemaVersion: 1,
        role: submission.role,
        consentToUseText: STAFF_INTERVIEW_CONSENT_TEXT,
        publicAnswers,
        withheld,
        uncertainties,
        missingInformation,
      }
      return {
        status: 'EXTRACTED',
        sourceId: source.id,
        evidence,
        discrepancies: [],
        claims,
        costUnits: evidence.length,
        candidate,
      }
    },
  }
}
