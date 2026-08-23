import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { PlatformWorkerPolicyCapability } from '@pathfinder/contracts/platform-worker-policy'
import {
  activatePlatformWorkerPolicyCredentialAction,
  issuePlatformWorkerPolicyCredentialAction,
  PlatformWorkerPolicyCredentialError,
  revokePlatformWorkerPolicyCredentialAction,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const lifecycle = z.object({
  operationId: z.string().uuid(),
  credentialId: z.string().trim().min(1).max(191),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
})

function mapError(error: unknown): never {
  if (error instanceof PlatformWorkerPolicyCredentialError) {
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT',
      message: error.message,
    })
  }
  throw error
}

export const adminPlatformWorkerPolicyCredentialsRouter = router({
  issuePlatformWorkerPolicyCredential: adminProcedure
    .input(
      z.object({
        operationId: z.string().uuid(),
        workerId: z.string().trim().min(1).max(191),
        label: z.string().trim().min(1).max(200),
        capabilities: z.array(PlatformWorkerPolicyCapability).min(1).max(1),
        expiresAt: z.string().datetime({ offset: true }).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await issuePlatformWorkerPolicyCredentialAction(
          {
            ...input,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          ctx.db,
        )
      } catch (error) {
        mapError(error)
      }
    }),

  activatePlatformWorkerPolicyCredential: adminProcedure
    .input(lifecycle)
    .mutation(async ({ ctx, input }) => {
      try {
        return await activatePlatformWorkerPolicyCredentialAction(
          {
            ...input,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          ctx.db,
        )
      } catch (error) {
        mapError(error)
      }
    }),

  revokePlatformWorkerPolicyCredential: adminProcedure
    .input(
      lifecycle.extend({
        reason: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Z][A-Z0-9_]*$/u),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await revokePlatformWorkerPolicyCredentialAction(
          {
            ...input,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          ctx.db,
        )
      } catch (error) {
        mapError(error)
      }
    }),

  listPlatformWorkerPolicyCredentials: adminProcedure.query(({ ctx }) =>
    ctx.db.platformWorkerPolicyCredential.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        workerId: true,
        label: true,
        capabilities: true,
        secretPrefix: true,
        hashAlgorithm: true,
        enabled: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        createdBy: true,
        activatedBy: true,
        activatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ),
})
