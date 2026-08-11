import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  STAFF_INTERVIEW_CONSENT_TEXT,
  STAFF_INTERVIEW_QUESTION_SETS,
  StaffInterviewSubmission,
  type StaffInterviewPrivacy,
} from '@pathfinder/contracts/staff-interview'

import { db } from '../client'

export type IntakeActionClient = Pick<
  typeof db,
  | 'venue'
  | 'intakeRun'
  | 'intakeEvidenceRecord'
  | 'intakeRunEvent'
  | 'venuePackage'
  | 'intakePackageHandoff'
  | '$transaction'
>

const privacyRank: Record<StaffInterviewPrivacy, number> = {
  PUBLIC_CANDIDATE: 0,
  INTERNAL_CONTEXT: 1,
  PRIVATE: 2,
}

export const interviewSubmissionInput = StaffInterviewSubmission.superRefine(
  (submission, context) => {
    if (
      !submission.consentToUse ||
      submission.acceptedConsentText !== STAFF_INTERVIEW_CONSENT_TEXT
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consentToUse'],
        message: 'The exact written-answer consent must be accepted.',
      })
    }
    const questions = new Map(
      STAFF_INTERVIEW_QUESTION_SETS[submission.role].map((question) => [question.id, question]),
    )
    submission.answers.forEach((answer, index) => {
      const question = questions.get(answer.questionId)
      if (!question) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answers', index, 'questionId'],
          message: `Question does not belong to the ${submission.role} interview.`,
        })
      } else if (privacyRank[answer.privacy] < privacyRank[question.defaultPrivacy]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answers', index, 'privacy'],
          message: `Privacy cannot be less restrictive than ${question.defaultPrivacy}.`,
        })
      }
    })
  },
)

export const websiteProposalInput = z
  .object({
    kind: z.literal('WEBSITE'),
    displayName: z.string().trim().min(1).max(255),
    websiteUri: z.string().url().max(2000),
  })
  .strict()

export const interviewProposalInput = z
  .object({
    kind: z.literal('INTERVIEW'),
    displayName: z.string().trim().min(1).max(255),
    submission: interviewSubmissionInput,
  })
  .strict()

export const intakeProposalInput = z.discriminatedUnion('kind', [
  websiteProposalInput,
  interviewProposalInput,
])
export type IntakeProposalInput = z.infer<typeof intakeProposalInput>

export type IntakeActionErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT'

export class IntakeActionError extends Error {
  constructor(
    readonly code: IntakeActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IntakeActionError'
  }
}

async function requireVenue(db: IntakeActionClient, tenantId: string, venueId: string) {
  const venue = await db.venue.findFirst({ where: { id: venueId, tenantId }, select: { id: true } })
  if (!venue) throw new IntakeActionError('NOT_FOUND', 'Venue not found')
}

export async function createIntakeProposal(input: {
  db: IntakeActionClient
  tenantId: string
  venueId: string
  actorId: string
  proposal: IntakeProposalInput
}) {
  const parsed = intakeProposalInput.safeParse(input.proposal)
  if (!parsed.success) throw new IntakeActionError('INVALID_INPUT', 'Invalid intake proposal')
  const proposal = parsed.data
  await requireVenue(input.db, input.tenantId, input.venueId)
  return input.db.$transaction(async (tx) => {
    const interview = proposal.kind === 'INTERVIEW' ? prepareInterview(proposal.submission) : null
    const run = await tx.intakeRun.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        sourceKind: proposal.kind,
        status: 'AWAITING_REVIEW',
        displayName: proposal.displayName,
        requestedBy: input.actorId,
        ...(proposal.kind === 'WEBSITE'
          ? { websiteUri: proposal.websiteUri }
          : {
              interviewRole: proposal.submission.role,
              interviewPublicAnswers: interview?.publicAnswers ?? [],
              interviewAnswerManifest: interview?.manifest ?? [],
              interviewConsentTextHash: createHash('sha256')
                .update(STAFF_INTERVIEW_CONSENT_TEXT)
                .digest('hex'),
            }),
      },
      select: {
        id: true,
        venueId: true,
        sourceKind: true,
        status: true,
        displayName: true,
        createdAt: true,
      },
    })
    if (proposal.kind === 'INTERVIEW' && interview) {
      for (const evidence of interview.evidence) {
        await tx.intakeEvidenceRecord.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: run.id,
            sourceKind: 'INTERVIEW',
            ...evidence,
            capturedAt: new Date(),
          },
        })
      }
    }
    await tx.intakeRunEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: run.id,
        kind: 'PROPOSAL_CREATED',
        actorId: input.actorId,
        metadata: { sourceKind: proposal.kind, autoApprove: false, autoApply: false },
      },
    })
    if (proposal.kind === 'INTERVIEW') {
      await tx.intakeRunEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: run.id,
          kind: 'EVIDENCE_RECORDED',
          actorId: input.actorId,
          metadata: {
            evidenceKind: 'CLASSIFIED_ANSWER_HASH',
            publicAnswerCount: interview?.publicAnswers.length ?? 0,
            withheldAnswerCount: interview?.withheldCount ?? 0,
          },
        },
      })
    }
    return {
      ...run,
      autoApprove: false as const,
      autoApply: false as const,
      nextAction: 'REVIEW_PROPOSAL' as const,
    }
  })
}

export async function listIntakeProposals(input: {
  db: IntakeActionClient
  tenantId: string
  venueId: string
  limit: number
}) {
  await requireVenue(input.db, input.tenantId, input.venueId)
  return input.db.intakeRun.findMany({
    where: { tenantId: input.tenantId, venueId: input.venueId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    select: {
      id: true,
      sourceKind: true,
      status: true,
      displayName: true,
      websiteUri: true,
      createdAt: true,
      _count: { select: { evidence: true, events: true } },
      packageHandoff: { select: { packageDraftId: true, createdAt: true } },
    },
  })
}

export async function linkIntakePackageDraft(input: {
  db: IntakeActionClient
  tenantId: string
  venueId: string
  runId: string
  packageDraftId: string
  actorId: string
}) {
  try {
    return await input.db.$transaction(async (tx) => {
      const [run, draft] = await Promise.all([
        tx.intakeRun.findFirst({
          where: { id: input.runId, tenantId: input.tenantId, venueId: input.venueId },
          select: { id: true },
        }),
        tx.venuePackage.findFirst({
          where: {
            id: input.packageDraftId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'DRAFT',
          },
          select: { id: true },
        }),
      ])
      if (!run || !draft) {
        throw new IntakeActionError('NOT_FOUND', 'Proposal or draft package not found')
      }
      const handoff = await tx.intakePackageHandoff.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: run.id,
          packageDraftId: draft.id,
          createdBy: input.actorId,
        },
        select: { id: true, runId: true, packageDraftId: true, createdAt: true },
      })
      await tx.intakeRunEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: run.id,
          kind: 'PACKAGE_DRAFT_LINKED',
          actorId: input.actorId,
          metadata: { packageDraftId: draft.id, statusRequired: 'DRAFT' },
        },
      })
      return { ...handoff, autoApprove: false as const, autoApply: false as const }
    })
  } catch (error) {
    if (error instanceof IntakeActionError) throw error
    if (isUniqueConflict(error)) {
      throw new IntakeActionError('CONFLICT', 'Proposal or package draft is already linked')
    }
    throw error
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function prepareInterview(submission: z.infer<typeof interviewSubmissionInput>) {
  const publicAnswers: Array<{
    questionId: string
    text: string
    privacy: 'PUBLIC_CANDIDATE'
    confidence: number
  }> = []
  const manifest: Array<{
    questionId: string
    privacy: StaffInterviewPrivacy
    skipped: boolean
    redacted: boolean
    uncertain: boolean
    confidence: number
    normalizedHash: string | null
  }> = []
  const evidence: Array<{ locator: string; normalizedHash: string; confidence: number }> = []
  let withheldCount = 0
  for (const answer of submission.answers) {
    const text = answer.text?.trim().replace(/\s+/gu, ' ')
    const normalizedHash =
      text && !answer.skipped && !answer.redacted
        ? createHash('sha256')
            .update(`${answer.questionId}:${answer.privacy}:${text}`)
            .digest('hex')
        : null
    if (normalizedHash) {
      evidence.push({
        locator: `interview:question:${answer.questionId}:${answer.privacy}`,
        normalizedHash,
        confidence: answer.confidence,
      })
    }
    if (answer.privacy === 'PUBLIC_CANDIDATE' && text && !answer.skipped && !answer.redacted) {
      publicAnswers.push({
        questionId: answer.questionId,
        text,
        privacy: 'PUBLIC_CANDIDATE',
        confidence: answer.confidence,
      })
    } else if (text && !answer.skipped && !answer.redacted) {
      withheldCount += 1
    }
    manifest.push({
      questionId: answer.questionId,
      privacy: answer.privacy,
      skipped: answer.skipped,
      redacted: answer.redacted,
      uncertain: answer.uncertain,
      confidence: answer.confidence,
      normalizedHash,
    })
  }
  return { publicAnswers, manifest, evidence, withheldCount }
}
