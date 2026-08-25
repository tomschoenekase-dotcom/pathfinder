import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const status = z.enum(['NEW', 'REVIEWED', 'ARCHIVED'])
const decision = z.enum(['MARK_REVIEWED', 'ARCHIVE', 'REOPEN'])

function operationHash(input: {
  submissionId: string
  decision: z.infer<typeof decision>
  reason?: string | undefined
}): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...input, reason: input.reason ?? null }), 'utf8')
    .digest('hex')
}

export const adminPublicInterestRouter = router({
  listPublicInterestSubmissions: adminProcedure
    .input(
      z
        .object({
          status: status.optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .strict()
        .default({ limit: 50 }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [items, grouped] = await Promise.all([
          db.publicInterestSubmission.findMany({
            ...(input.status ? { where: { status: input.status } } : {}),
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: input.limit,
            select: {
              id: true,
              organizationName: true,
              contactName: true,
              workEmail: true,
              website: true,
              cityRegion: true,
              venueType: true,
              message: true,
              sourcePath: true,
              status: true,
              reviewedAt: true,
              reviewedBy: true,
              createdAt: true,
              reviews: {
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 5,
                select: {
                  id: true,
                  decision: true,
                  reason: true,
                  reviewerId: true,
                  createdAt: true,
                },
              },
            },
          }),
          db.publicInterestSubmission.groupBy({ by: ['status'], _count: { _all: true } }),
        ])
        return {
          items,
          counts: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
          policy: {
            createsCanonicalProspect: false,
            sendsCommunication: false,
            pricingAuthorityGranted: false,
          },
        }
      }),
    ),

  reviewPublicInterestSubmission: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          submissionId: z.string().cuid(),
          decision,
          reason: z.string().trim().min(3).max(1000).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const hash = operationHash({
          submissionId: input.submissionId,
          decision: input.decision,
          ...(input.reason ? { reason: input.reason } : {}),
        })
        return db.$transaction(async (tx) => {
          const replay = await tx.publicInterestSubmissionReview.findUnique({
            where: { operationId: input.operationId },
            select: { operationHash: true, submission: true },
          })
          if (replay) {
            if (replay.operationHash !== hash) {
              throw new TRPCError({ code: 'CONFLICT', message: 'Operation id was already used' })
            }
            return replay.submission
          }

          const current = await tx.publicInterestSubmission.findUnique({
            where: { id: input.submissionId },
            select: { id: true, status: true },
          })
          if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Submission not found' })

          const nextStatus =
            input.decision === 'MARK_REVIEWED'
              ? 'REVIEWED'
              : input.decision === 'ARCHIVE'
                ? 'ARCHIVED'
                : 'NEW'
          if (input.decision === 'REOPEN' && current.status === 'NEW') {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Submission is already new' })
          }

          await tx.publicInterestSubmissionReview.create({
            data: {
              operationId: input.operationId,
              operationHash: hash,
              submissionId: input.submissionId,
              decision: input.decision,
              reason: input.reason ?? null,
              reviewerId: ctx.session.userId,
            },
          })
          return tx.publicInterestSubmission.update({
            where: { id: input.submissionId },
            data: {
              status: nextStatus,
              reviewedAt: nextStatus === 'NEW' ? null : new Date(),
              reviewedBy: nextStatus === 'NEW' ? null : ctx.session.userId,
            },
          })
        })
      }),
    ),
})
