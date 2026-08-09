import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  GLOBAL_AI_CONTROL_KEY,
  globalAiControlValueSchema,
} from '@pathfinder/config/incident-control'
import { db, readGlobalAiControl, writeAuditLogStrict } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { isUniqueConstraintError } from './helpers'

const updateInput = z
  .object({
    paused: z.boolean(),
    reason: z.string().trim().min(1).max(500),
    expectedUpdatedAt: z.coerce.date().nullable(),
  })
  .strict()

function conflict(): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'Global AI control changed; refresh and try again.',
  })
}

export const adminIncidentControlRouter = router({
  getGlobalAiControl: adminProcedure.query(() => readGlobalAiControl(db)),

  setGlobalAiControl: adminProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    try {
      return await db.$transaction(async (transaction) => {
        const before = await readGlobalAiControl(transaction)
        if (!before.configured && input.expectedUpdatedAt !== null) conflict()
        if (
          before.configured &&
          (input.expectedUpdatedAt === null ||
            before.updatedAt?.getTime() !== input.expectedUpdatedAt.getTime())
        ) {
          conflict()
        }

        if (!before.malformed && before.paused === input.paused && before.reason === input.reason) {
          return { ...before, replayed: true }
        }

        const value = globalAiControlValueSchema.parse({
          schemaVersion: 1,
          paused: input.paused,
          reason: input.reason,
        })
        const nextUpdatedAt = new Date(
          before.updatedAt ? Math.max(Date.now(), before.updatedAt.getTime() + 1) : Date.now(),
        )

        if (before.configured) {
          if (!before.updatedAt) conflict()
          const updated = await transaction.platformConfig.updateMany({
            where: { key: GLOBAL_AI_CONTROL_KEY, updatedAt: before.updatedAt },
            data: { value, updatedBy: ctx.session.userId, updatedAt: nextUpdatedAt },
          })
          if (updated.count !== 1) conflict()
        } else {
          await transaction.platformConfig.create({
            data: {
              key: GLOBAL_AI_CONTROL_KEY,
              value,
              updatedBy: ctx.session.userId,
              updatedAt: nextUpdatedAt,
            },
          })
        }

        await writeAuditLogStrict(
          {
            actorId: ctx.session.userId,
            actorRole: 'PLATFORM_ADMIN',
            action: input.paused ? 'admin.global-ai.paused' : 'admin.global-ai.resumed',
            targetType: 'PlatformConfig',
            targetId: GLOBAL_AI_CONTROL_KEY,
            beforeState: {
              paused: before.paused,
              reason: before.reason,
              malformed: before.malformed,
            },
            afterState: { paused: value.paused, reason: value.reason, malformed: false },
          },
          transaction,
        )

        return {
          ...value,
          configured: true,
          malformed: false,
          updatedAt: nextUpdatedAt,
          updatedBy: ctx.session.userId,
          replayed: false,
        }
      })
    } catch (error) {
      if (error instanceof TRPCError) throw error
      if (isUniqueConstraintError(error)) conflict()
      throw error
    }
  }),
})
