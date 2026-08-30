import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { AI_PROVIDER_REGISTRY } from '@pathfinder/ai'
import {
  AiProviderHealthControlActionError,
  db,
  GlobalAiControlActionError,
  readAiProviderHealthControl,
  readGlobalAiControl,
  setAiProviderHealthOverrideAction,
  setGlobalAiControlAction,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const updateInput = z
  .object({
    paused: z.boolean(),
    reason: z.string().trim().min(1).max(500),
    expectedUpdatedAt: z.coerce.date().nullable(),
  })
  .strict()

const providerIds = Object.keys(AI_PROVIDER_REGISTRY) as [
  keyof typeof AI_PROVIDER_REGISTRY,
  ...(keyof typeof AI_PROVIDER_REGISTRY)[],
]
const providerUpdateInput = z
  .object({
    provider: z.enum(providerIds),
    unhealthy: z.boolean(),
    reason: z.string().trim().min(1).max(500),
    expiresAt: z.coerce.date().nullable(),
    expectedUpdatedAt: z.coerce.date().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.unhealthy && value.expiresAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'A future expiry is required when excluding a provider.',
      })
    }
    if (!value.unhealthy && value.expiresAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Restoring a provider must clear its expiry.',
      })
    }
  })

function conflict(): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'Global AI control changed; refresh and try again.',
  })
}

function mapActionError(error: unknown): never {
  if (error instanceof GlobalAiControlActionError) {
    if (error.code === 'CONFLICT') conflict()
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error })
  }
  throw error
}

function mapProviderActionError(error: unknown): never {
  if (error instanceof AiProviderHealthControlActionError) {
    if (error.code === 'CONFLICT') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'AI provider health control changed; refresh and try again.',
      })
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error })
  }
  throw error
}

export const adminIncidentControlRouter = router({
  getGlobalAiControl: adminProcedure.query(() => readGlobalAiControl(db)),

  getAiProviderHealthControl: adminProcedure.query(() => readAiProviderHealthControl(db)),

  setGlobalAiControl: adminProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    try {
      return await setGlobalAiControlAction(
        {
          ...input,
          actor: {
            type: 'HUMAN',
            id: ctx.session.userId,
            role: 'PLATFORM_ADMIN',
          },
        },
        db,
      )
    } catch (error) {
      mapActionError(error)
    }
  }),

  setAiProviderHealthOverride: adminProcedure
    .input(providerUpdateInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await setAiProviderHealthOverrideAction(
          {
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          db,
        )
      } catch (error) {
        mapProviderActionError(error)
      }
    }),
})
