import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'

export const markFounderBriefingReviewedInput = z
  .object({
    operationId: z.string().uuid(),
    reviewedThrough: z.string().datetime(),
    expectedPreviousReviewedThrough: z.string().datetime().nullable(),
    briefingSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  })
  .strict()

type Input = z.infer<typeof markFounderBriefingReviewedInput>

const safeSelect = {
  id: true,
  operationId: true,
  operatorUserId: true,
  reviewedThrough: true,
  previousReviewedThrough: true,
  briefingSchemaVersion: true,
  createdAt: true,
} as const

function sameDate(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime()
}

function conflict(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message })
}

function serialize(
  row: {
    id: string
    operationId: string
    reviewedThrough: Date
    previousReviewedThrough: Date | null
    briefingSchemaVersion: number
    createdAt: Date
  },
  replayed: boolean,
) {
  return {
    id: row.id,
    operationId: row.operationId,
    reviewedThrough: row.reviewedThrough,
    previousReviewedThrough: row.previousReviewedThrough,
    briefingSchemaVersion: row.briefingSchemaVersion,
    createdAt: row.createdAt,
    replayed,
    executionTriggered: false as const,
  }
}

export function readFounderBriefingReview(operatorUserId: string) {
  return db.founderControlRoomReview.findFirst({
    where: { operatorUserId },
    orderBy: [{ reviewedThrough: 'desc' }, { createdAt: 'desc' }],
    select: safeSelect,
  })
}

export async function markFounderBriefingReviewed(operatorUserId: string, input: Input) {
  const reviewedThrough = new Date(input.reviewedThrough)
  const expectedPreviousReviewedThrough = input.expectedPreviousReviewedThrough
    ? new Date(input.expectedPreviousReviewedThrough)
    : null
  if (reviewedThrough.getTime() > Date.now() + 60_000) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The reviewed-through timestamp cannot be in the future.',
    })
  }

  try {
    return await db.$transaction(async (tx) => {
      const replay = await tx.founderControlRoomReview.findUnique({
        where: { operationId: input.operationId },
        select: safeSelect,
      })
      if (replay) {
        if (
          replay.operatorUserId !== operatorUserId ||
          replay.reviewedThrough.getTime() !== reviewedThrough.getTime() ||
          !sameDate(replay.previousReviewedThrough, expectedPreviousReviewedThrough) ||
          replay.briefingSchemaVersion !== input.briefingSchemaVersion
        ) {
          conflict('The operation id is already bound to another review checkpoint.')
        }
        return serialize(replay, true)
      }

      const latest = await tx.founderControlRoomReview.findFirst({
        where: { operatorUserId },
        orderBy: [{ reviewedThrough: 'desc' }, { createdAt: 'desc' }],
        select: safeSelect,
      })
      const actualPrevious = latest?.reviewedThrough ?? null
      if (!sameDate(actualPrevious, expectedPreviousReviewedThrough)) {
        conflict('The Founder Control Room review state changed. Refresh before recording review.')
      }
      if (actualPrevious && reviewedThrough.getTime() <= actualPrevious.getTime()) {
        conflict('The review cursor must advance monotonically.')
      }

      const created = await tx.founderControlRoomReview.create({
        data: {
          operationId: input.operationId,
          operatorUserId,
          reviewedThrough,
          previousReviewedThrough: actualPrevious,
          briefingSchemaVersion: input.briefingSchemaVersion,
        },
        select: safeSelect,
      })
      return serialize(created, false)
    })
  } catch (error) {
    if (error instanceof TRPCError) throw error
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      const replay = await db.founderControlRoomReview.findUnique({
        where: { operationId: input.operationId },
        select: safeSelect,
      })
      if (
        replay &&
        replay.operatorUserId === operatorUserId &&
        replay.reviewedThrough.getTime() === reviewedThrough.getTime() &&
        sameDate(replay.previousReviewedThrough, expectedPreviousReviewedThrough) &&
        replay.briefingSchemaVersion === input.briefingSchemaVersion
      ) {
        return serialize(replay, true)
      }
      conflict('The Founder Control Room review state changed. Refresh before retrying.')
    }
    throw error
  }
}
