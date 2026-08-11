import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { AgentIdentityConfigurationFields } from '@pathfinder/contracts'
import {
  AgentIdentityConfigurationError,
  createDisabledAgentIdentity as createDisabledAgentIdentityAction,
  disableAgentIdentity as disableAgentIdentityAction,
  editDisabledAgentIdentity as editDisabledAgentIdentityAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const agentIdentityScope = z.discriminatedUnion('level', [
  z.object({ level: z.literal('CLIENT'), tenantId: z.string().min(1) }).strict(),
  z
    .object({
      level: z.literal('VENUE'),
      tenantId: z.string().min(1),
      venueId: z.string().min(1),
    })
    .strict(),
])

function identityConfigurationError(error: unknown): never {
  if (error instanceof AgentIdentityConfigurationError) {
    const code =
      error.code === 'INVALID_INPUT'
        ? 'BAD_REQUEST'
        : error.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.code
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

export const adminAgentIdentityConfigurationRouter = router({
  createDisabledAgentIdentity: adminProcedure
    .input(
      z.object({ scope: agentIdentityScope, fields: AgentIdentityConfigurationFields }).strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await createDisabledAgentIdentityAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          identityConfigurationError(error)
        }
      }),
    ),

  editDisabledAgentIdentity: adminProcedure
    .input(
      z
        .object({
          scope: agentIdentityScope,
          agentIdentityId: z.string().min(1),
          expectedUpdatedAt: z.coerce.date(),
          fields: AgentIdentityConfigurationFields,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await editDisabledAgentIdentityAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          identityConfigurationError(error)
        }
      }),
    ),

  disableAgentIdentity: adminProcedure
    .input(
      z
        .object({
          scope: agentIdentityScope,
          agentIdentityId: z.string().min(1),
          expectedUpdatedAt: z.coerce.date(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await disableAgentIdentityAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          identityConfigurationError(error)
        }
      }),
    ),
})
