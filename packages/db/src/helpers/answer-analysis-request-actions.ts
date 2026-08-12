import { createHash, randomUUID } from 'node:crypto'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AnswerAnalysisRequestActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type AnswerAnalysisRequestActionClient = Pick<typeof db, '$transaction'>
export type AnswerAnalysisRequestActionErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_INPUT'
  | 'PRECONDITION_FAILED'

export class AnswerAnalysisRequestActionError extends Error {
  constructor(
    readonly code: AnswerAnalysisRequestActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AnswerAnalysisRequestActionError'
  }
}

type RequestInput = {
  tenantId: string
  venueId: string
  rangeStart: Date
  rangeEnd: Date
  requestId: string
  actor: AnswerAnalysisRequestActor
}

const dispatchSelect = {
  id: true,
  recordId: true,
  requestHash: true,
  status: true,
} as const
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function fail(code: AnswerAnalysisRequestActionErrorCode, message: string): never {
  throw new AnswerAnalysisRequestActionError(code, message)
}

function requireInput(input: RequestInput): void {
  if (
    !input.actor ||
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id.trim() ||
    !input.tenantId.trim() ||
    !input.venueId.trim() ||
    !requestIdPattern.test(input.requestId) ||
    !(input.rangeStart instanceof Date) ||
    !(input.rangeEnd instanceof Date) ||
    Number.isNaN(input.rangeStart.getTime()) ||
    Number.isNaN(input.rangeEnd.getTime())
  ) {
    fail('INVALID_INPUT', 'An exact analysis scope and human platform administrator are required')
  }
  if (input.rangeStart.getTime() > input.rangeEnd.getTime()) {
    fail('INVALID_INPUT', 'Analysis range start must be before or equal to range end')
  }
}

export function answerAnalysisRequestHash(input: {
  venueId: string
  rangeStart: Date
  rangeEnd: Date
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'pathfinder-generation-request-v1',
        'ANSWER_ANALYSIS',
        input.venueId,
        input.rangeStart.toISOString(),
        input.rangeEnd.toISOString(),
      ]),
    )
    .digest('hex')
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export async function requestAnswerAnalysisAction(
  input: RequestInput,
  client: AnswerAnalysisRequestActionClient = db,
) {
  // Validate before opening a transaction so malformed or inverted ranges cannot
  // acquire locks or manufacture durable request evidence.
  requireInput(input)
  const requestHash = answerAnalysisRequestHash(input)

  const createOrReplay = () =>
    client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const venue = await tx.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true, isActive: true },
      })
      if (!venue) fail('NOT_FOUND', 'Venue not found')
      if (venue.isActive === false) {
        fail('PRECONDITION_FAILED', 'This venue is temporarily unavailable.')
      }

      const existing = await tx.generationRequestDispatch.findFirst({
        where: {
          tenantId: input.tenantId,
          kind: 'ANSWER_ANALYSIS',
          requestId: input.requestId,
        },
        select: dispatchSelect,
      })
      if (existing) {
        if (existing.requestHash !== requestHash) {
          fail('CONFLICT', 'Request ID was already used for different analysis input.')
        }
        return { ...existing, replayed: true as const }
      }

      const snapshotId = randomUUID()
      const dispatchId = randomUUID()
      await tx.answerAnalysisSnapshot.create({
        data: {
          id: snapshotId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          rangeStart: input.rangeStart,
          rangeEnd: input.rangeEnd,
          status: 'GENERATING',
          createdBy: input.actor.id,
        },
      })
      const dispatch = await tx.generationRequestDispatch.create({
        data: {
          id: dispatchId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          kind: 'ANSWER_ANALYSIS',
          requestId: input.requestId,
          requestHash,
          recordId: snapshotId,
          rangeStart: input.rangeStart,
          rangeEnd: input.rangeEnd,
          answerAnalysisSnapshotId: snapshotId,
        },
        select: dispatchSelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.answer_analysis.requested',
          targetType: 'AnswerAnalysisSnapshot',
          targetId: snapshotId,
          afterState: {
            venueId: input.venueId,
            rangeStart: input.rangeStart.toISOString(),
            rangeEnd: input.rangeEnd.toISOString(),
            requestId: input.requestId,
          },
        },
        tx,
      )
      return { ...dispatch, replayed: false as const }
    })

  try {
    return await createOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    // A concurrent request may have won the unique request identity. Re-read
    // through the complete action so scope, availability and hash all revalidate.
    return createOrReplay()
  }
}
