import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import {
  createFileExtractionClarificationQuestion,
  FILE_CLARIFICATION_BLOCKER_SCOPES,
  FILE_CLARIFICATION_REASONS,
  FileClarificationError,
  resolveFileExtractionClarification,
} from '../../lib/intake-file-clarifications'
import { adminProcedure } from '../../trpc'

export const adminIntakeFileClarificationsRouter = router({
  createFileExtractionClarificationQuestion: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          runId: z.string().trim().min(1).max(191),
          receiptId: z.string().uuid(),
          expectedExtractedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
          fieldPath: z.string().trim().min(1).max(500),
          reason: z.enum(FILE_CLARIFICATION_REASONS),
          blockerScope: z.enum(FILE_CLARIFICATION_BLOCKER_SCOPES),
          question: z.string().trim().min(1).max(2_000),
          evidenceExcerpt: z.string().trim().min(1).max(1_000),
          agentIdentityId: z.string().trim().min(1).max(191),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createFileExtractionClarificationQuestion({ db: ctx.db, ...input })
      } catch (error) {
        if (error instanceof FileClarificationError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : error.code === 'INVALID_INPUT'
                    ? 'BAD_REQUEST'
                    : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),
  resolveFileExtractionClarification: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          runId: z.string().trim().min(1).max(191),
          receiptId: z.string().uuid(),
          requestId: z.string().uuid(),
          expectedExtractedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
          questionId: z.string().trim().min(1).max(191),
          expectedAnsweredAt: z.date(),
          kind: z.enum(['REPLACE_EXCERPT', 'EXCLUDE_EVIDENCE']),
          amendedExcerpt: z.string().trim().min(1).max(2_000).optional(),
          rationale: z.string().trim().min(1).max(500),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.kind === 'REPLACE_EXCERPT' && !value.amendedExcerpt) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['amendedExcerpt'],
              message: 'Replacement resolution requires an amended excerpt.',
            })
          }
          if (value.kind === 'EXCLUDE_EVIDENCE' && value.amendedExcerpt !== undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['amendedExcerpt'],
              message: 'Evidence exclusion cannot carry an amended excerpt.',
            })
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { amendedExcerpt, ...resolutionInput } = input
        return await resolveFileExtractionClarification({
          db: ctx.db,
          ...resolutionInput,
          actorId: ctx.session.userId!,
          ...(amendedExcerpt ? { amendedExcerpt } : {}),
        })
      } catch (error) {
        if (error instanceof FileClarificationError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : error.code === 'INVALID_INPUT'
                    ? 'BAD_REQUEST'
                    : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),
})
