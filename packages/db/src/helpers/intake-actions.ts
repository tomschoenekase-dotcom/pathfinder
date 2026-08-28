import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { MachineActorContext } from '@pathfinder/contracts/actor'

import {
  STAFF_INTERVIEW_CONSENT_TEXT,
  STAFF_INTERVIEW_QUESTION_SETS,
  StaffInterviewSubmission,
  type StaffInterviewPrivacy,
} from '@pathfinder/contracts/staff-interview'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type IntakeActionClient = Pick<
  typeof db,
  | 'venue'
  | 'intakeRun'
  | 'intakeEvidenceRecord'
  | 'intakeRunEvent'
  | 'venuePackage'
  | 'intakePackageHandoff'
  | 'auditLog'
  | '$transaction'
>

const privacyRank: Record<StaffInterviewPrivacy, number> = {
  PUBLIC_CANDIDATE: 0,
  INTERNAL_CONTEXT: 1,
  PRIVATE: 2,
}

// Preserve review access for interviews captured before the Torchiko rename.
const LEGACY_STAFF_INTERVIEW_CONSENT_SHA256 =
  'a5cf3db6904cd5191ac3cad19554ca19357c660da36636b0dd11a0dd37dabab6'

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

export const notesProposalInput = z
  .object({
    kind: z.literal('NOTES'),
    notes: z.string().trim().min(1).max(20_000),
  })
  .strict()

export const intakeProposalInput = z.discriminatedUnion('kind', [
  websiteProposalInput,
  interviewProposalInput,
  notesProposalInput,
])
export type IntakeProposalInput = z.infer<typeof intakeProposalInput>
export type IntakeProposalActor =
  | {
      type: 'HUMAN'
      id: string
      role: 'MANAGER' | 'OWNER' | 'PLATFORM_ADMIN'
    }
  | (MachineActorContext & {
      capability: 'intake:draft'
      approvalGrantId: string
      idempotencyKey: string
    })

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
  actor: IntakeProposalActor
  requestId: string
  proposal: IntakeProposalInput
}) {
  const humanActor = input.actor?.type === 'HUMAN' ? input.actor : null
  const machineActor = input.actor?.type === 'AGENT' ? input.actor : null
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.tenantId !== 'string' ||
    !input.tenantId.trim() ||
    typeof input.venueId !== 'string' ||
    !input.venueId.trim() ||
    !input.actor ||
    (humanActor &&
      (typeof humanActor.id !== 'string' ||
        !humanActor.id.trim() ||
        !['MANAGER', 'OWNER', 'PLATFORM_ADMIN'].includes(humanActor.role))) ||
    (machineActor &&
      (machineActor.role !== 'AGENT' ||
        !machineActor.actorId.trim() ||
        machineActor.actorId !== machineActor.agentIdentityId ||
        !machineActor.agentRunId.trim() ||
        !machineActor.workerId.trim() ||
        !machineActor.credentialId.trim() ||
        !machineActor.approvalGrantId.trim() ||
        machineActor.capability !== 'intake:draft' ||
        machineActor.idempotencyKey !== input.requestId ||
        (machineActor.modelProvider === undefined) !== (machineActor.modelName === undefined))) ||
    (!humanActor && !machineActor) ||
    !z.string().uuid().safeParse(input.requestId).success
  ) {
    throw new IntakeActionError('INVALID_INPUT', 'Invalid intake proposal scope')
  }
  const parsed = intakeProposalInput.safeParse(input.proposal)
  if (!parsed.success) throw new IntakeActionError('INVALID_INPUT', 'Invalid intake proposal')
  const proposal = parsed.data
  if (machineActor && proposal.kind !== 'NOTES') {
    throw new IntakeActionError('INVALID_INPUT', 'Machine intake proposals are NOTES-only')
  }
  const actorId = humanActor ? humanActor.id : machineActor!.actorId
  const storedSourceKind = proposal.kind === 'NOTES' ? 'STRUCTURED_BOOTSTRAP' : proposal.kind
  const displayName = proposal.kind === 'NOTES' ? 'Optional notes' : proposal.displayName
  const inputHash = createHash('sha256')
    .update(
      canonicalJson({
        tenantId: input.tenantId,
        venueId: input.venueId,
        actor: input.actor,
        proposal,
      }),
    )
    .digest('hex')
  await requireVenue(input.db, input.tenantId, input.venueId)
  const replaySelect = {
    id: true,
    venueId: true,
    sourceKind: true,
    status: true,
    displayName: true,
    requestedBy: true,
    requestedByType: true,
    agentIdentityId: true,
    agentRunId: true,
    workerId: true,
    credentialId: true,
    approvalGrantId: true,
    capability: true,
    modelProvider: true,
    modelName: true,
    submissionInputHash: true,
    createdAt: true,
  } as const
  const safeResult = (
    run: {
      id: string
      venueId: string
      sourceKind: string
      status: string
      displayName: string
      createdAt: Date
    },
    replayed: boolean,
  ) => ({
    id: run.id,
    venueId: run.venueId,
    sourceKind: run.sourceKind,
    status: run.status,
    displayName: run.displayName,
    createdAt: run.createdAt,
    autoApprove: false as const,
    autoApply: false as const,
    nextAction: 'REVIEW_PROPOSAL' as const,
    replayed,
  })
  try {
    return await input.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-proposal:${input.tenantId}:${input.requestId}`}, 0))`
      const replay = await tx.intakeRun.findFirst({
        where: { tenantId: input.tenantId, submissionRequestId: input.requestId },
        select: replaySelect,
      })
      if (replay) {
        if (
          replay.submissionInputHash !== inputHash ||
          replay.requestedBy !== actorId ||
          replay.venueId !== input.venueId ||
          replay.sourceKind !== storedSourceKind ||
          (replay.requestedByType ?? 'HUMAN') !== input.actor.type ||
          (machineActor &&
            (replay.agentIdentityId !== machineActor.agentIdentityId ||
              replay.agentRunId !== machineActor.agentRunId ||
              replay.workerId !== machineActor.workerId ||
              replay.credentialId !== machineActor.credentialId ||
              replay.approvalGrantId !== machineActor.approvalGrantId ||
              replay.capability !== machineActor.capability ||
              replay.modelProvider !== (machineActor.modelProvider ?? null) ||
              replay.modelName !== (machineActor.modelName ?? null)))
        ) {
          throw new IntakeActionError(
            'CONFLICT',
            'This request key is already bound to a different intake proposal.',
          )
        }
        return safeResult(replay, true)
      }
      const interview = proposal.kind === 'INTERVIEW' ? prepareInterview(proposal.submission) : null
      const notesHash =
        proposal.kind === 'NOTES'
          ? createHash('sha256').update(proposal.notes.trim().replace(/\s+/gu, ' ')).digest('hex')
          : null
      const run = await tx.intakeRun.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          sourceKind: storedSourceKind,
          status: 'AWAITING_REVIEW',
          displayName,
          requestedBy: actorId,
          requestedByType: input.actor.type,
          ...(machineActor
            ? {
                agentIdentityId: machineActor.agentIdentityId,
                agentRunId: machineActor.agentRunId,
                workerId: machineActor.workerId,
                credentialId: machineActor.credentialId,
                approvalGrantId: machineActor.approvalGrantId,
                capability: machineActor.capability,
                ...(machineActor.modelProvider
                  ? { modelProvider: machineActor.modelProvider }
                  : {}),
                ...(machineActor.modelName ? { modelName: machineActor.modelName } : {}),
              }
            : {}),
          submissionRequestId: input.requestId,
          submissionInputHash: inputHash,
          ...(proposal.kind === 'WEBSITE'
            ? { websiteUri: proposal.websiteUri }
            : proposal.kind === 'INTERVIEW'
              ? {
                  interviewRole: proposal.submission.role,
                  interviewPublicAnswers: interview?.publicAnswers ?? [],
                  interviewAnswerManifest: interview?.manifest ?? [],
                  interviewConsentTextHash: createHash('sha256')
                    .update(STAFF_INTERVIEW_CONSENT_TEXT)
                    .digest('hex'),
                }
              : {
                  structuredBootstrap: {
                    kind: 'OPTIONAL_NOTES',
                    notes: proposal.notes,
                  },
                }),
        },
        select: replaySelect,
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
      if (proposal.kind === 'NOTES' && notesHash) {
        await tx.intakeEvidenceRecord.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: run.id,
            sourceKind: 'STRUCTURED_BOOTSTRAP',
            locator: `optional-notes:${run.id}`,
            normalizedHash: notesHash,
            confidence: 1,
            capturedAt: new Date(),
          },
        })
      }
      await tx.intakeRunEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: run.id,
          kind: 'PROPOSAL_CREATED',
          actorId,
          metadata: {
            sourceKind: storedSourceKind,
            proposalKind: proposal.kind,
            autoApprove: false,
            autoApply: false,
            requestedByType: input.actor.type,
          },
        },
      })
      if (proposal.kind === 'INTERVIEW') {
        await tx.intakeRunEvent.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: run.id,
            kind: 'EVIDENCE_RECORDED',
            actorId,
            metadata: {
              evidenceKind: 'CLASSIFIED_ANSWER_HASH',
              publicAnswerCount: interview?.publicAnswers.length ?? 0,
              withheldAnswerCount: interview?.withheldCount ?? 0,
            },
          },
        })
      }
      if (proposal.kind === 'NOTES') {
        await tx.intakeRunEvent.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: run.id,
            kind: 'EVIDENCE_RECORDED',
            actorId,
            metadata: { evidenceKind: 'OPTIONAL_NOTES_HASH', evidenceCount: 1 },
          },
        })
      }
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId,
          actorRole: input.actor.role,
          action: 'intake.proposal-created',
          targetType: 'IntakeRun',
          targetId: run.id,
          afterState: {
            sourceKind: storedSourceKind,
            proposalKind: proposal.kind,
            status: 'AWAITING_REVIEW',
            requestHash: inputHash,
            evidenceCount: interview?.evidence.length ?? (notesHash ? 1 : 0),
            publicAnswerCount: interview?.publicAnswers.length ?? 0,
            withheldAnswerCount: interview?.withheldCount ?? 0,
            requestedByType: input.actor.type,
            ...(machineActor
              ? {
                  agentIdentityId: machineActor.agentIdentityId,
                  agentRunId: machineActor.agentRunId,
                  workerId: machineActor.workerId,
                  credentialId: machineActor.credentialId,
                  approvalGrantId: machineActor.approvalGrantId,
                  capability: machineActor.capability,
                  modelProvider: machineActor.modelProvider ?? null,
                  modelName: machineActor.modelName ?? null,
                  idempotencyKey: machineActor.idempotencyKey,
                }
              : {}),
          },
        },
        tx,
      )
      return safeResult(run, false)
    })
  } catch (error) {
    if (error instanceof IntakeActionError) throw error
    if (isUniqueConflict(error)) {
      const replay = await input.db.intakeRun.findFirst({
        where: { tenantId: input.tenantId, submissionRequestId: input.requestId },
        select: replaySelect,
      })
      if (
        replay?.submissionInputHash === inputHash &&
        replay.requestedBy === actorId &&
        replay.venueId === input.venueId &&
        replay.sourceKind === storedSourceKind &&
        (replay.requestedByType ?? 'HUMAN') === input.actor.type &&
        (!machineActor ||
          (replay.agentIdentityId === machineActor.agentIdentityId &&
            replay.agentRunId === machineActor.agentRunId &&
            replay.workerId === machineActor.workerId &&
            replay.credentialId === machineActor.credentialId &&
            replay.approvalGrantId === machineActor.approvalGrantId &&
            replay.capability === machineActor.capability &&
            replay.modelProvider === (machineActor.modelProvider ?? null) &&
            replay.modelName === (machineActor.modelName ?? null)))
      ) {
        return safeResult(replay, true)
      }
      throw new IntakeActionError(
        'CONFLICT',
        'This request key is already bound to a different intake proposal.',
      )
    }
    throw error
  }
}

export async function listIntakeProposals(input: {
  db: IntakeActionClient
  tenantId: string
  venueId: string
  limit: number
}) {
  await requireVenue(input.db, input.tenantId, input.venueId)
  return input.db.intakeRun.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceKind: { in: ['WEBSITE', 'INTERVIEW', 'STRUCTURED_BOOTSTRAP'] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    select: {
      id: true,
      sourceKind: true,
      status: true,
      displayName: true,
      websiteUri: true,
      interviewRole: true,
      structuredBootstrap: true,
      createdAt: true,
      _count: { select: { evidence: true, events: true } },
      packageHandoff: { select: { packageDraftId: true, createdAt: true } },
    },
  })
}

const reviewManifestEntry = z
  .object({
    questionId: z.string().min(1),
    privacy: z.enum(['PUBLIC_CANDIDATE', 'INTERNAL_CONTEXT', 'PRIVATE']),
    skipped: z.boolean(),
    redacted: z.boolean(),
    uncertain: z.boolean(),
    confidence: z.number().min(0).max(1),
    normalizedHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict()

const reviewPublicAnswer = z
  .object({
    questionId: z.string().min(1),
    text: z.string().trim().min(1).max(20_000),
    privacy: z.literal('PUBLIC_CANDIDATE'),
    confidence: z.number().min(0).max(1),
  })
  .strict()

export async function getIntakeProposalReview(input: {
  db: IntakeActionClient
  tenantId: string
  venueId: string
  runId: string
}) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.tenantId !== 'string' ||
    !input.tenantId.trim() ||
    typeof input.venueId !== 'string' ||
    !input.venueId.trim() ||
    typeof input.runId !== 'string' ||
    !input.runId.trim()
  ) {
    throw new IntakeActionError('INVALID_INPUT', 'Invalid intake review scope')
  }
  await requireVenue(input.db, input.tenantId, input.venueId)
  const run = await input.db.intakeRun.findFirst({
    where: {
      id: input.runId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceKind: 'INTERVIEW',
    },
    select: {
      id: true,
      sourceKind: true,
      status: true,
      displayName: true,
      interviewRole: true,
      interviewPublicAnswers: true,
      interviewAnswerManifest: true,
      interviewConsentTextHash: true,
      createdAt: true,
      evidence: {
        orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          sourceKind: true,
          locator: true,
          normalizedHash: true,
          confidence: true,
          capturedAt: true,
        },
      },
      events: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, kind: true, createdAt: true },
      },
    },
  })
  if (!run || !run.interviewRole) {
    throw new IntakeActionError('NOT_FOUND', 'Interview proposal not found')
  }
  const role = z
    .enum(['EXECUTIVE', 'VISITOR_SERVICES', 'OPERATIONS', 'ACCESSIBILITY', 'CONTENT'])
    .safeParse(run.interviewRole)
  const manifest = z.array(reviewManifestEntry).max(100).safeParse(run.interviewAnswerManifest)
  const publicAnswers = z.array(reviewPublicAnswer).max(100).safeParse(run.interviewPublicAnswers)
  if (!role.success || !manifest.success || !publicAnswers.success) {
    throw new IntakeActionError('CONFLICT', 'Stored interview review evidence is invalid')
  }
  const questions = new Map(
    STAFF_INTERVIEW_QUESTION_SETS[role.data].map((question) => [question.id, question]),
  )
  const manifestIds = new Set(manifest.data.map((answer) => answer.questionId))
  const publicIds = new Set(publicAnswers.data.map((answer) => answer.questionId))
  if (
    manifestIds.size !== manifest.data.length ||
    publicIds.size !== publicAnswers.data.length ||
    manifestIds.size !== questions.size ||
    [...questions.keys()].some((questionId) => !manifestIds.has(questionId)) ||
    [...publicIds].some((questionId) => !manifestIds.has(questionId))
  ) {
    throw new IntakeActionError('CONFLICT', 'Stored interview answer set is inconsistent')
  }
  const publicByQuestion = new Map(publicAnswers.data.map((answer) => [answer.questionId, answer]))
  const consentHashes = new Set([
    createHash('sha256').update(STAFF_INTERVIEW_CONSENT_TEXT).digest('hex'),
    LEGACY_STAFF_INTERVIEW_CONSENT_SHA256,
  ])
  const evidenceByLocator = new Map(run.evidence.map((evidence) => [evidence.locator, evidence]))
  const hashedAnswers = manifest.data.filter((answer) => answer.normalizedHash !== null)
  if (
    !run.interviewConsentTextHash ||
    !consentHashes.has(run.interviewConsentTextHash) ||
    evidenceByLocator.size !== run.evidence.length ||
    hashedAnswers.length !== run.evidence.length
  ) {
    throw new IntakeActionError('CONFLICT', 'Stored interview evidence is inconsistent')
  }
  const answers = manifest.data.map((answer) => {
    const question = questions.get(answer.questionId)
    if (!question) throw new IntakeActionError('CONFLICT', 'Stored interview question is invalid')
    const publicAnswer = publicByQuestion.get(answer.questionId)
    const evidence = evidenceByLocator.get(
      `interview:question:${answer.questionId}:${answer.privacy}`,
    )
    if (
      (answer.privacy === 'PUBLIC_CANDIDATE' &&
        !answer.skipped &&
        !answer.redacted &&
        !publicAnswer) ||
      (answer.privacy !== 'PUBLIC_CANDIDATE' && publicAnswer) ||
      (publicAnswer && publicAnswer.confidence !== answer.confidence) ||
      ((answer.skipped || answer.redacted) && answer.normalizedHash !== null) ||
      (!answer.skipped && !answer.redacted && answer.normalizedHash === null) ||
      (answer.normalizedHash !== null &&
        (!evidence ||
          evidence.sourceKind !== 'INTERVIEW' ||
          evidence.normalizedHash !== answer.normalizedHash ||
          Number(evidence.confidence) !== answer.confidence)) ||
      (publicAnswer &&
        createHash('sha256')
          .update(
            `${answer.questionId}:${answer.privacy}:${publicAnswer.text.trim().replace(/\s+/gu, ' ')}`,
          )
          .digest('hex') !== answer.normalizedHash) ||
      (answer.redacted && answer.skipped)
    ) {
      throw new IntakeActionError('CONFLICT', 'Stored interview privacy evidence is inconsistent')
    }
    const discrepancies = [
      ...(question.required && (answer.skipped || answer.redacted)
        ? (['MISSING_CONTEXT'] as const)
        : []),
      ...(answer.uncertain || answer.confidence < 0.6 ? (['LOW_CONFIDENCE'] as const) : []),
    ]
    return {
      questionId: answer.questionId,
      prompt: question.prompt,
      fieldPath: question.fieldPath,
      required: question.required,
      privacy: answer.privacy,
      skipped: answer.skipped,
      redacted: answer.redacted,
      uncertain: answer.uncertain,
      confidence: answer.confidence,
      hasEvidence: answer.normalizedHash !== null,
      evidenceId: evidence?.id ?? null,
      publicText: publicAnswer?.text ?? null,
      discrepancies,
    }
  })
  const consentVerified = true
  const discrepancyCount = answers.reduce((count, answer) => count + answer.discrepancies.length, 0)
  return {
    id: run.id,
    sourceKind: run.sourceKind,
    status: run.status,
    displayName: run.displayName,
    role: role.data,
    consentVerified,
    answers,
    structuredSummary: {
      candidateFields: answers
        .filter((answer) => answer.publicText !== null)
        .map((answer) => ({
          fieldPath: answer.fieldPath,
          publicText: answer.publicText!,
          confidence: answer.confidence,
          discrepancies: answer.discrepancies,
        })),
      flaggedFields: answers
        .filter((answer) => answer.discrepancies.length > 0)
        .map((answer) => ({
          fieldPath: answer.fieldPath,
          discrepancies: answer.discrepancies,
          publicText: answer.publicText,
        })),
      withheldFields: answers
        .filter((answer) => answer.publicText === null)
        .map((answer) => ({
          fieldPath: answer.fieldPath,
          privacy: answer.privacy,
          reason: answer.skipped
            ? ('SKIPPED' as const)
            : answer.redacted
              ? ('REDACTED' as const)
              : answer.hasEvidence
                ? ('WITHHELD' as const)
                : ('NO_TEXT' as const),
        })),
      handoffReady:
        consentVerified &&
        run.status === 'AWAITING_REVIEW' &&
        discrepancyCount === 0 &&
        answers.some((answer) => answer.publicText !== null),
    },
    summary: {
      answerCount: answers.length,
      publicAnswerCount: answers.filter((answer) => answer.publicText !== null).length,
      withheldAnswerCount: answers.filter(
        (answer) => answer.hasEvidence && answer.publicText === null,
      ).length,
      skippedCount: answers.filter((answer) => answer.skipped).length,
      redactedCount: answers.filter((answer) => answer.redacted).length,
      uncertainCount: answers.filter((answer) => answer.uncertain).length,
      discrepancyCount,
      evidenceCount: run.evidence.length,
    },
    evidence: run.evidence.map((evidence) => ({
      id: evidence.id,
      confidence: Number(evidence.confidence),
      capturedAt: evidence.capturedAt,
    })),
    timeline: run.events,
    createdAt: run.createdAt,
    autoApprove: false as const,
    autoApply: false as const,
    published: false as const,
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
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
