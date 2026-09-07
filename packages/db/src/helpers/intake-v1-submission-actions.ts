import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  STAFF_INTERVIEW_CONSENT_TEXT,
  STAFF_INTERVIEW_QUESTION_SETS,
} from '@pathfinder/contracts/staff-interview'
import { db } from '../client'
import {
  createIntakeProposalInTransaction,
  type IntakeActionClient,
  intakeProposalInput,
  type IntakeProposalInput,
} from './intake-actions'
import { intakeSubmissionDraftContent } from './intake-submission-draft-actions'

const sourceKind = z.enum(['WEBSITE', 'INTERVIEW', 'NOTES'])
const uuid = z.string().uuid()
export const intakeV1SubmissionSelection = z
  .object({
    operationId: uuid,
    partialAcknowledged: z.boolean(),
    drafts: z
      .record(
        sourceKind,
        z.object({ include: z.boolean(), expectedRevision: z.number().int().min(1) }),
      )
      .default({}),
    intakeRunIds: z.array(z.string().min(1).max(191)).max(50).default([]),
    intakeUploadIds: z.array(z.string().min(1).max(191)).max(50).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const count =
      Object.values(value.drafts).filter((draft) => draft.include).length +
      value.intakeRunIds.length +
      value.intakeUploadIds.length
    if (count > 50)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A V1 submission may include at most 50 members.',
      })
    if (
      new Set(value.intakeRunIds).size !== value.intakeRunIds.length ||
      new Set(value.intakeUploadIds).size !== value.intakeUploadIds.length
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Selected source IDs must be unique.' })
  })

type Client = IntakeActionClient &
  Pick<
    typeof db,
    | 'intakeV1Submission'
    | 'intakeV1SubmissionRevision'
    | 'intakeV1SubmissionMember'
    | 'intakeUpload'
    | 'intakeUploadVerificationReceipt'
  >
export class IntakeV1SubmissionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
  }
}
const compareCodePoints = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0
const canonicalJson = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => compareCodePoints(a, b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
          .join(',')}}`
      : JSON.stringify(value)
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')

export function materializeIntakeV1Draft(
  content: z.infer<typeof intakeSubmissionDraftContent>,
): IntakeProposalInput | null {
  if (content.kind === 'WEBSITE') {
    const proposal = intakeProposalInput.safeParse({
      kind: 'WEBSITE',
      displayName: content.displayName,
      websiteUri: content.websiteUri,
    })
    return proposal.success ? proposal.data : null
  }
  if (content.kind === 'NOTES') {
    const proposal = intakeProposalInput.safeParse({ kind: 'NOTES', notes: content.notes })
    return proposal.success ? proposal.data : null
  }
  const questions = STAFF_INTERVIEW_QUESTION_SETS[content.role]
  if (!content.consent || !content.displayName.trim()) return null
  const drafts = content.draftsByRole[content.role] ?? {}
  const expectedIds = new Set(questions.map((question) => question.id))
  if (
    Object.keys(drafts).length !== questions.length ||
    Object.keys(drafts).some((id) => !expectedIds.has(id))
  )
    return null
  const privacyRank = { PUBLIC_CANDIDATE: 0, INTERNAL_CONTEXT: 1, PRIVATE: 2 } as const
  const answers = questions.map((question) => {
    const answer = drafts[question.id]
    if (
      !answer ||
      (answer.mode === 'ANSWER' && !answer.text.trim()) ||
      privacyRank[answer.privacy] < privacyRank[question.defaultPrivacy]
    )
      return null
    return {
      questionId: question.id,
      ...(answer!.mode === 'ANSWER' ? { text: answer!.text.trim() } : {}),
      privacy: answer!.privacy,
      skipped: answer!.mode === 'SKIP',
      redacted: answer!.mode === 'REDACT',
      uncertain: answer!.uncertain,
      confidence: answer!.confidence,
    }
  })
  if (answers.some((answer) => answer === null)) return null
  const proposal = intakeProposalInput.safeParse({
    kind: 'INTERVIEW',
    displayName: content.displayName.trim(),
    submission: {
      role: content.role,
      consentToUse: true,
      acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
      answers: answers as NonNullable<(typeof answers)[number]>[],
    },
  })
  return proposal.success ? proposal.data : null
}

export async function submitIntakeV1Action(input: {
  tenantId: string
  venueId: string
  ownerUserId: string
  actorRole: 'MANAGER' | 'OWNER'
  selection: z.input<typeof intakeV1SubmissionSelection>
  amend?: { submissionId: string; expectedCurrentRevision: number }
  client?: Client
}) {
  const parsed = intakeV1SubmissionSelection.safeParse(input.selection)
  if (!parsed.success)
    throw new IntakeV1SubmissionError('INVALID_INPUT', 'Invalid V1 submission selection.')
  const value = parsed.data
  const client = input.client ?? (db as Client)
  const requestHash = digest({
    venueId: input.venueId,
    ownerUserId: input.ownerUserId,
    amend: input.amend ?? null,
    drafts: value.drafts,
    intakeRunIds: [...value.intakeRunIds].sort(compareCodePoints),
    intakeUploadIds: [...value.intakeUploadIds].sort(compareCodePoints),
    partialAcknowledged: value.partialAcknowledged,
  })
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-v1:${input.tenantId}:${value.operationId}`}, 0))`
    const replay = await tx.intakeV1SubmissionRevision.findFirst({
      where: { tenantId: input.tenantId, operationId: value.operationId },
      include: { submission: true },
    })
    if (replay) {
      if (
        replay.venueId !== input.venueId ||
        replay.submission.ownerUserId !== input.ownerUserId ||
        replay.requestHash !== requestHash
      )
        throw new IntakeV1SubmissionError(
          'CONFLICT',
          'This V1 operation is already bound to different material.',
        )
      return {
        submissionId: replay.submissionId,
        revision: replay.revision,
        manifestHash: replay.manifestHash,
        status: replay.submission.status,
        replayed: true,
        criticalMissing: replay.criticalMissing,
      }
    }
    if (input.amend)
      await tx.$queryRaw`SELECT id FROM intake_v1_submissions
        WHERE id=${input.amend.submissionId} AND tenant_id=${input.tenantId}
          AND venue_id=${input.venueId} AND owner_user_id=${input.ownerUserId} FOR UPDATE`
    const amended = input.amend
      ? await tx.intakeV1Submission.findFirst({
          where: {
            id: input.amend.submissionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            ownerUserId: input.ownerUserId,
          },
        })
      : null
    if (input.amend && (!amended || amended.revision !== input.amend.expectedCurrentRevision))
      throw new IntakeV1SubmissionError(
        'CONFLICT',
        'The V1 submission changed; reload before amending.',
      )
    const selectedDrafts = (
      Object.entries(value.drafts).filter(([, draft]) => draft.include) as Array<
        [z.infer<typeof sourceKind>, { include: boolean; expectedRevision: number }]
      >
    ).sort(([left], [right]) => compareCodePoints(left, right))
    const drafts = selectedDrafts.length
      ? await tx.intakeSubmissionDraft.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ownerUserId: input.ownerUserId,
            sourceKind: { in: selectedDrafts.map(([kind]) => kind) },
          },
          select: { sourceKind: true, revision: true, submittedAt: true, content: true },
        })
      : []
    const draftByKind = new Map(drafts.map((draft) => [draft.sourceKind, draft]))
    const exclusions: Array<{ code: string; sourceKind: string; sourceId?: string }> = []
    const materialized: Array<{
      sourceKind: z.infer<typeof sourceKind>
      proposal: IntakeProposalInput
      revision: number
    }> = []
    for (const [kind, expected] of selectedDrafts) {
      const draft = draftByKind.get(kind)
      const content = draft ? intakeSubmissionDraftContent.safeParse(draft.content) : null
      const proposal = content?.success ? materializeIntakeV1Draft(content.data) : null
      if (draft && draft.revision !== expected.expectedRevision)
        throw new IntakeV1SubmissionError(
          'CONFLICT',
          'A selected draft changed; reload before submitting.',
        )
      if (
        !draft ||
        draft.submittedAt ||
        !content?.success ||
        content.data.kind !== kind ||
        !proposal
      )
        exclusions.push({
          code: !draft
            ? 'DRAFT_MISSING'
            : draft.submittedAt
              ? 'DRAFT_ALREADY_SUBMITTED'
              : 'DRAFT_INCOMPLETE',
          sourceKind: kind,
        })
      else materialized.push({ sourceKind: kind, proposal, revision: draft.revision })
    }
    if (exclusions.length && !value.partialAcknowledged)
      throw new IntakeV1SubmissionError(
        'CONFLICT',
        'One or more selected drafts are incomplete or changed; confirm a partial V1 submission to exclude them.',
      )
    for (const runId of [...value.intakeRunIds].sort(compareCodePoints))
      await tx.$queryRaw`SELECT id FROM intake_runs WHERE id=${runId}
        AND tenant_id=${input.tenantId} AND venue_id=${input.venueId}
        AND requested_by=${input.ownerUserId} AND requested_by_type='HUMAN' FOR SHARE`
    const existingRuns = value.intakeRunIds.length
      ? await tx.intakeRun.findMany({
          where: {
            id: { in: value.intakeRunIds },
            tenantId: input.tenantId,
            venueId: input.venueId,
            requestedBy: input.ownerUserId,
            requestedByType: 'HUMAN',
          },
          select: { id: true, sourceKind: true, submissionInputHash: true, createdAt: true },
        })
      : []
    if (existingRuns.length !== value.intakeRunIds.length)
      throw new IntakeV1SubmissionError(
        'NOT_FOUND',
        'One or more selected intake sources are unavailable.',
      )
    const hashlessRuns = existingRuns.filter((run) => !run.submissionInputHash)
    if (hashlessRuns.length && !value.partialAcknowledged)
      throw new IntakeV1SubmissionError(
        'CONFLICT',
        'One or more selected sources lack a canonical input hash; confirm a partial V1 submission to exclude them.',
      )
    for (const run of hashlessRuns)
      exclusions.push({
        code: 'RUN_CANONICAL_HASH_UNAVAILABLE',
        sourceKind: 'INTAKE_RUN',
        sourceId: run.id,
      })
    const eligibleExistingRuns = existingRuns.filter(
      (run): run is typeof run & { submissionInputHash: string } =>
        Boolean(run.submissionInputHash),
    )
    for (const uploadId of [...value.intakeUploadIds].sort(compareCodePoints))
      await tx.$queryRaw`SELECT id FROM intake_uploads WHERE id=${uploadId}
        AND tenant_id=${input.tenantId} AND venue_id=${input.venueId}
        AND requested_by=${input.ownerUserId} FOR SHARE`
    const uploads = value.intakeUploadIds.length
      ? await tx.intakeUpload.findMany({
          where: {
            id: { in: value.intakeUploadIds },
            tenantId: input.tenantId,
            venueId: input.venueId,
            requestedBy: input.ownerUserId,
          },
          select: {
            id: true,
            status: true,
            sha256: true,
            byteSize: true,
            objectGeneration: true,
            storageVersionId: true,
            intakeRunId: true,
          },
        })
      : []
    if (uploads.length !== value.intakeUploadIds.length)
      throw new IntakeV1SubmissionError(
        'NOT_FOUND',
        'One or more selected uploads are unavailable.',
      )
    const selectedRunIds = new Set(value.intakeRunIds)
    const duplicateSemanticUpload = uploads.find(
      (upload) => upload.intakeRunId && selectedRunIds.has(upload.intakeRunId),
    )
    if (duplicateSemanticUpload)
      throw new IntakeV1SubmissionError(
        'INVALID_INPUT',
        'Select either an intake run or its source upload, not both.',
      )
    const verificationEligible = uploads.filter(
      (upload) => upload.status === 'AWAITING_REVIEW' && upload.intakeRunId,
    )
    for (const upload of [...verificationEligible].sort((left, right) =>
      compareCodePoints(left.id, right.id),
    ))
      await tx.$queryRaw`SELECT id FROM intake_upload_verification_receipts
        WHERE tenant_id=${input.tenantId} AND venue_id=${input.venueId}
          AND upload_id=${upload.id} AND kind='MALWARE' FOR SHARE`
    const receipts =
      verificationEligible.length === 0
        ? []
        : await tx.intakeUploadVerificationReceipt.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              uploadId: { in: verificationEligible.map((upload) => upload.id) },
              kind: 'MALWARE',
              verdict: 'CLEAN',
            },
            select: {
              uploadId: true,
              verdictHash: true,
              computedSha256: true,
              computedByteSize: true,
              objectGeneration: true,
              storageVersionId: true,
            },
          })
    const receiptByUploadId = new Map(receipts.map((receipt) => [receipt.uploadId, receipt]))
    const eligibleUploads = uploads.filter((upload) => {
      const receipt = receiptByUploadId.get(upload.id)
      return Boolean(
        upload.status === 'AWAITING_REVIEW' &&
        upload.intakeRunId &&
        receipt &&
        receipt.objectGeneration === upload.objectGeneration &&
        receipt.computedSha256 === upload.sha256 &&
        receipt.computedByteSize === upload.byteSize &&
        receipt.storageVersionId === upload.storageVersionId,
      )
    })
    for (const upload of uploads.filter((upload) => !eligibleUploads.includes(upload)))
      exclusions.push({ code: 'UPLOAD_NOT_VERIFIED', sourceKind: 'UPLOAD', sourceId: upload.id })
    if (uploads.length !== eligibleUploads.length && !value.partialAcknowledged)
      throw new IntakeV1SubmissionError(
        'CONFLICT',
        'One or more selected uploads are not verified; confirm a partial V1 submission to exclude them.',
      )
    const newRuns: Array<Awaited<ReturnType<typeof createIntakeProposalInTransaction>>> = []
    for (const item of materialized)
      newRuns.push(
        await createIntakeProposalInTransaction({
          db: client,
          transaction: tx,
          tenantId: input.tenantId,
          venueId: input.venueId,
          actor: { type: 'HUMAN', id: input.ownerUserId, role: input.actorRole },
          requestId: randomUUID(),
          proposal: item.proposal,
          draft: { ownerUserId: input.ownerUserId, expectedRevision: item.revision },
        }),
      )
    if (newRuns.some((run) => !run.submissionInputHash))
      throw new IntakeV1SubmissionError(
        'CONFLICT',
        'A materialized draft did not retain its canonical input hash.',
      )
    if (!newRuns.length && !eligibleExistingRuns.length && !eligibleUploads.length)
      throw new IntakeV1SubmissionError(
        'PRECONDITION_FAILED',
        'Select at least one complete source or verified upload for V1.',
      )
    const members = [
      ...eligibleExistingRuns.map((run) => ({
        kind: 'INTAKE_RUN' as const,
        id: run.id,
        immutableHash: run.submissionInputHash,
      })),
      ...newRuns.flatMap((run) =>
        run.submissionInputHash
          ? [
              {
                kind: 'INTAKE_RUN' as const,
                id: run.id,
                immutableHash: run.submissionInputHash,
              },
            ]
          : [],
      ),
      ...eligibleUploads.map((upload) => ({
        kind: 'INTAKE_UPLOAD' as const,
        id: upload.id,
        immutableHash: digest({ id: upload.id, receipt: receiptByUploadId.get(upload.id) }),
      })),
    ].sort((a, b) => compareCodePoints(a.kind, b.kind) || compareCodePoints(a.id, b.id))
    const criticalMissing = [...exclusions].sort(
      (left, right) =>
        compareCodePoints(left.sourceKind, right.sourceKind) ||
        compareCodePoints(left.sourceId ?? '', right.sourceId ?? '') ||
        compareCodePoints(left.code, right.code),
    )
    const manifest = {
      schemaVersion: 1,
      members: members.map((member) => ({
        kind: member.kind,
        id: member.id,
        immutableHash: member.immutableHash,
      })),
      criticalMissing,
    }
    const manifestHash = digest(manifest)
    const nextRevision = amended ? amended.revision + 1 : 1
    const submission =
      amended ??
      (await tx.intakeV1Submission.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          ownerUserId: input.ownerUserId,
          operationId: value.operationId,
          requestHash,
          status: 'AWAITING_CANONICAL_REVIEW',
          revision: 1,
        },
      }))
    if (amended) {
      const advanced = await tx.intakeV1Submission.updateMany({
        where: {
          id: amended.id,
          tenantId: input.tenantId,
          revision: input.amend!.expectedCurrentRevision,
        },
        data: { revision: nextRevision },
      })
      if (advanced.count !== 1)
        throw new IntakeV1SubmissionError(
          'CONFLICT',
          'The V1 submission changed; reload before amending.',
        )
    }
    const revision = await tx.intakeV1SubmissionRevision.create({
      data: {
        submissionId: submission.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        revision: nextRevision,
        operationId: value.operationId,
        requestHash,
        manifest,
        manifestHash,
        criticalMissing,
      },
    })
    await tx.intakeV1SubmissionMember.createMany({
      data: members.map((member, ordinal) => ({
        revisionId: revision.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        ordinal,
        kind: member.kind,
        immutableHash: member.immutableHash,
        ...(member.kind === 'INTAKE_RUN'
          ? { intakeRunId: member.id }
          : { intakeUploadId: member.id }),
      })),
    })
    return {
      submissionId: submission.id,
      revision: nextRevision,
      manifestHash,
      status: submission.status,
      replayed: false,
      criticalMissing,
    }
  })
}

/** Reads bounded immutable revision pages. Every revision is a full replacement
 * manifest; callers must carry forward members they still intend to include. */
export async function getIntakeV1SubmissionAction(input: {
  tenantId: string
  venueId: string
  ownerUserId: string
  submissionId: string
  revisionCursor?: number
  revisionLimit?: number
  client?: Client
}) {
  const revisionLimit = input.revisionLimit ?? 20
  if (
    !Number.isInteger(revisionLimit) ||
    revisionLimit < 1 ||
    revisionLimit > 20 ||
    (input.revisionCursor !== undefined &&
      (!Number.isInteger(input.revisionCursor) || input.revisionCursor < 1))
  )
    throw new IntakeV1SubmissionError('INVALID_INPUT', 'Invalid V1 revision page.')
  const submission = await (input.client ?? (db as Client)).intakeV1Submission.findFirst({
    where: {
      id: input.submissionId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      ownerUserId: input.ownerUserId,
    },
    select: {
      id: true,
      status: true,
      revision: true,
      revisions: {
        ...(input.revisionCursor === undefined
          ? {}
          : { where: { revision: { lt: input.revisionCursor } } }),
        orderBy: { revision: 'desc' },
        take: revisionLimit + 1,
        include: {
          members: {
            orderBy: { ordinal: 'asc' },
            select: {
              ordinal: true,
              kind: true,
              immutableHash: true,
              intakeRunId: true,
              intakeUploadId: true,
              intakeRun: { select: { displayName: true, sourceKind: true } },
              intakeUpload: { select: { displayName: true, intakeRunId: true } },
            },
          },
        },
      },
    },
  })
  if (!submission) throw new IntakeV1SubmissionError('NOT_FOUND', 'V1 submission not found.')
  const revisions = submission.revisions.slice(0, revisionLimit)
  const last = revisions.at(-1)
  return {
    id: submission.id,
    status: submission.status,
    revision: submission.revision,
    revisions: revisions.map((revision) => ({
      revision: revision.revision,
      manifestHash: revision.manifestHash,
      criticalMissing: revision.criticalMissing,
      createdAt: revision.createdAt,
      members: revision.members.map((member) => ({
        ordinal: member.ordinal,
        kind: member.kind,
        immutableHash: member.immutableHash,
        intakeRunId: member.intakeRunId,
        intakeUploadId: member.intakeUploadId,
        linkedIntakeRunId: member.intakeUpload?.intakeRunId ?? null,
        displayName: member.intakeRun?.displayName ?? member.intakeUpload?.displayName ?? null,
        sourceKind: member.intakeRun?.sourceKind ?? null,
      })),
    })),
    revisionSemantics: 'FULL_REPLACEMENT' as const,
    nextRevisionCursor: submission.revisions.length > revisionLimit && last ? last.revision : null,
  }
}

export async function getLatestIntakeV1SubmissionAction(input: {
  tenantId: string
  venueId: string
  ownerUserId: string
  revisionLimit?: number
  client?: Client
}) {
  const client = input.client ?? (db as Client)
  const latest = await client.intakeV1Submission.findFirst({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      ownerUserId: input.ownerUserId,
    },
    select: { id: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  })
  if (!latest) return null
  return getIntakeV1SubmissionAction({
    ...input,
    submissionId: latest.id,
  })
}

export async function listIntakeV1CandidatesAction(input: {
  tenantId: string
  venueId: string
  ownerUserId: string
  limit: number
  cursor?: { createdAt: string; id: string }
  client?: Client
}) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
    throw new IntakeV1SubmissionError('INVALID_INPUT', 'Candidate limit must be between 1 and 50.')
  const client = input.client ?? (db as Client)
  const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
  if (cursorDate && Number.isNaN(cursorDate.getTime()))
    throw new IntakeV1SubmissionError('INVALID_INPUT', 'Invalid candidate cursor.')
  const rows = await client.intakeRun.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      requestedBy: input.ownerUserId,
      requestedByType: 'HUMAN',
      submissionInputHash: { not: null },
      ...(cursorDate && input.cursor
        ? {
            OR: [
              { createdAt: { lt: cursorDate } },
              { createdAt: cursorDate, id: { lt: input.cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: {
      id: true,
      displayName: true,
      sourceKind: true,
      status: true,
      submissionInputHash: true,
      createdAt: true,
    },
  })
  const items = rows.slice(0, input.limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > input.limit && last
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null,
  }
}

export async function listIntakeV1UploadCandidatesAction(input: {
  tenantId: string
  venueId: string
  ownerUserId: string
  limit: number
  cursor?: { createdAt: string; id: string }
  client?: Client
}) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
    throw new IntakeV1SubmissionError('INVALID_INPUT', 'Candidate limit must be between 1 and 50.')
  const client = input.client ?? (db as Client)
  const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
  if (cursorDate && Number.isNaN(cursorDate.getTime()))
    throw new IntakeV1SubmissionError('INVALID_INPUT', 'Invalid candidate cursor.')
  const rows = await client.intakeUpload.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      requestedBy: input.ownerUserId,
      ...(cursorDate && input.cursor
        ? {
            OR: [
              { createdAt: { lt: cursorDate } },
              { createdAt: cursorDate, id: { lt: input.cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: {
      id: true,
      displayName: true,
      status: true,
      intakeRunId: true,
      createdAt: true,
    },
  })
  const items = rows.slice(0, input.limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > input.limit && last
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null,
  }
}
