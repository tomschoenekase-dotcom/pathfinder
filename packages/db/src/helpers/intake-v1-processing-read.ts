import { z } from 'zod'

import { db } from '../client'

type Client = Pick<typeof db, 'intakeV1SubmissionRevision'>

const inputSchema = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    ownerUserId: z.string().min(1).max(191),
    submissionId: z.string().min(1).max(191),
    revision: z.number().int().min(1),
    websiteResearchEnabled: z.boolean(),
    fileExtractionEnabled: z.boolean().default(false),
  })
  .strict()

export class IntakeV1ProcessingReadError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeV1ProcessingReadError'
  }
}

function sourceLabel(sourceKind: string | null, uploaded: boolean): string {
  if (uploaded) return 'Uploaded file'
  if (sourceKind === 'WEBSITE') return 'Website'
  if (sourceKind === 'INTERVIEW') return 'Staff answers'
  if (sourceKind === 'STRUCTURED_BOOTSTRAP' || sourceKind === 'NOTES') return 'Shared notes'
  return 'Shared information'
}

type ProcessingDispatchRead = {
  kind: string
  status: string
  holdReason: string | null
  leaseExpiresAt: Date | null
}

function workerDispatch(
  dispatch: ProcessingDispatchRead | null,
): dispatch is ProcessingDispatchRead {
  return dispatch?.kind === 'WEBSITE_RESEARCH' || dispatch?.kind === 'FILE_EXTRACTION'
}

function processingEnabled(
  dispatch: ProcessingDispatchRead | null,
  flags: { websiteResearchEnabled: boolean; fileExtractionEnabled: boolean },
) {
  if (dispatch?.kind === 'WEBSITE_RESEARCH') return flags.websiteResearchEnabled
  if (dispatch?.kind === 'FILE_EXTRACTION') return flags.fileExtractionEnabled
  return true
}

function disabledReason(dispatch: ProcessingDispatchRead | null) {
  return dispatch?.kind === 'FILE_EXTRACTION'
    ? ('FILE_EXTRACTION_DISABLED' as const)
    : ('WEBSITE_RESEARCH_DISABLED' as const)
}

function recoveryPending(dispatch: ProcessingDispatchRead | null, now: Date): boolean {
  return (
    workerDispatch(dispatch) &&
    dispatch.status === 'LEASED' &&
    (dispatch.leaseExpiresAt === null || dispatch.leaseExpiresAt <= now)
  )
}

function safeReason(
  dispatch: ProcessingDispatchRead | null,
  flags: { websiteResearchEnabled: boolean; fileExtractionEnabled: boolean },
  now: Date,
) {
  if (!dispatch) return 'NOT_SCHEDULED_HISTORICAL' as const
  if (recoveryPending(dispatch, now)) {
    return processingEnabled(dispatch, flags)
      ? ('PROCESSING_RECOVERY_PENDING' as const)
      : disabledReason(dispatch)
  }
  if (
    workerDispatch(dispatch) &&
    dispatch.status === 'PENDING' &&
    !processingEnabled(dispatch, flags)
  )
    return disabledReason(dispatch)
  if (dispatch.status === 'FAILED') return 'PROCESSING_FAILED' as const
  if (dispatch.status !== 'HELD') return null
  if (dispatch.holdReason === 'EXTRACTION_NOT_EXECUTABLE')
    return 'EXTRACTION_NOT_EXECUTABLE' as const
  if (dispatch.holdReason === 'PRIOR_RESEARCH_NOT_SUCCESSFUL')
    return 'PRIOR_RESEARCH_NOT_SUCCESSFUL' as const
  return 'PROCESSING_HELD' as const
}

function ownerStatus(
  dispatch: ProcessingDispatchRead | null,
  flags: { websiteResearchEnabled: boolean; fileExtractionEnabled: boolean },
  now: Date,
) {
  if (!dispatch) return 'NOT_SCHEDULED' as const
  if (recoveryPending(dispatch, now)) {
    return processingEnabled(dispatch, flags) ? ('PENDING' as const) : ('POLICY_DISABLED' as const)
  }
  if (
    workerDispatch(dispatch) &&
    dispatch.status === 'PENDING' &&
    !processingEnabled(dispatch, flags)
  )
    return 'POLICY_DISABLED' as const
  if (dispatch.status === 'LEASED') return 'IN_PROGRESS' as const
  return dispatch.status as 'PENDING' | 'COMPLETED' | 'HELD' | 'FAILED'
}

export async function getIntakeV1ProcessingRead(
  input: z.input<typeof inputSchema>,
  client: Client = db,
  clock: () => Date = () => new Date(),
) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success)
    throw new IntakeV1ProcessingReadError('INVALID_INPUT', 'Invalid V1 processing scope.')
  const scope = parsed.data
  // Read-model time is captured once, deliberately separate from the DB
  // worker's authoritative lifecycle clock, so every member is projected
  // against one coherent owner-visible instant.
  const now = clock()
  const row = await client.intakeV1SubmissionRevision.findFirst({
    where: {
      submissionId: scope.submissionId,
      revision: scope.revision,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      submission: { ownerUserId: scope.ownerUserId },
    },
    select: {
      submissionId: true,
      revision: true,
      createdAt: true,
      members: {
        orderBy: { ordinal: 'asc' },
        take: 51,
        select: {
          id: true,
          ordinal: true,
          intakeRun: { select: { displayName: true, sourceKind: true } },
          intakeUpload: { select: { displayName: true } },
          processingDispatch: {
            select: { kind: true, status: true, holdReason: true, leaseExpiresAt: true },
          },
        },
      },
    },
  })
  if (!row) throw new IntakeV1ProcessingReadError('NOT_FOUND', 'V1 submission revision not found.')
  if (row.members.length > 50)
    throw new IntakeV1ProcessingReadError(
      'CONFLICT',
      'V1 submission revision exceeds its member bound.',
    )

  const flags = {
    websiteResearchEnabled: scope.websiteResearchEnabled,
    fileExtractionEnabled: scope.fileExtractionEnabled,
  }
  const members = row.members.map((member) => {
    const status = ownerStatus(member.processingDispatch, flags, now)
    return {
      memberId: member.id,
      ordinal: member.ordinal,
      displayName: member.intakeRun?.displayName ?? member.intakeUpload?.displayName ?? null,
      sourceLabel: sourceLabel(member.intakeRun?.sourceKind ?? null, Boolean(member.intakeUpload)),
      processingKind: member.processingDispatch?.kind ?? null,
      status,
      reasonCode: safeReason(member.processingDispatch, flags, now),
    }
  })
  const counts = {
    total: members.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    held: 0,
    failed: 0,
    policyDisabled: 0,
    notScheduled: 0,
  }
  for (const member of members) {
    if (member.status === 'PENDING') counts.pending += 1
    else if (member.status === 'IN_PROGRESS') counts.inProgress += 1
    else if (member.status === 'COMPLETED') counts.completed += 1
    else if (member.status === 'HELD') counts.held += 1
    else if (member.status === 'FAILED') counts.failed += 1
    else if (member.status === 'POLICY_DISABLED') counts.policyDisabled += 1
    else counts.notScheduled += 1
  }
  return {
    submissionId: row.submissionId,
    revision: row.revision,
    createdAt: row.createdAt,
    counts,
    members,
    completionMeaning: 'MATERIAL_PROCESSING_ONLY' as const,
    publicationCreated: false as const,
  }
}
