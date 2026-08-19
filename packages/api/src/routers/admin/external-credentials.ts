import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  activateAgentBridgeCredentialAction,
  ExternalCredentialActionError,
  issueExternalCredentialAction,
  revokeExternalCredentialAction,
  rotateExternalCredentialAction,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scope = z
  .object({
    tenantId: z.string().min(1),
    clientId: z.string().min(1),
  })
  .strict()
const cursor = z
  .object({ createdAt: z.string().datetime({ offset: true }), id: z.string().min(1) })
  .strict()

const credentialSelect = {
  id: true,
  tenantId: true,
  clientId: true,
  venueId: true,
  kind: true,
  label: true,
  capabilities: true,
  secretPrefix: true,
  hashAlgorithm: true,
  enabled: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const

function assertClientScope(input: { tenantId: string; clientId: string }) {
  if (input.tenantId !== input.clientId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Client must match tenant scope' })
  }
}

function mapActionError(error: unknown): never {
  if (error instanceof ExternalCredentialActionError) {
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

const actionScope = scope.extend({
  venueId: z.string().trim().min(1).max(191).nullable(),
  operationId: z.string().uuid(),
})

export const adminExternalCredentialsRouter = router({
  activateAgentBridgeCredential: adminProcedure
    .input(
      actionScope.extend({
        venueId: z.string().trim().min(1).max(191),
        credentialId: z.string().trim().min(1).max(191),
        expectedUpdatedAt: z.string().datetime({ offset: true }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await activateAgentBridgeCredentialAction(
          {
            ...input,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  issueExternalCredential: adminProcedure
    .input(
      actionScope.extend({
        kind: z.enum(['MCP', 'PARTNER_READ_API']),
        label: z.string().trim().min(1).max(200),
        capabilities: z.array(z.string().trim().min(1)).min(1).max(50),
        expiresAt: z.string().datetime({ offset: true }).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await issueExternalCredentialAction(
          {
            ...input,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  rotateExternalCredential: adminProcedure
    .input(
      actionScope.extend({
        credentialId: z.string().trim().min(1).max(191),
        expectedUpdatedAt: z.string().datetime({ offset: true }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await rotateExternalCredentialAction(
          {
            ...input,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  revokeExternalCredential: adminProcedure
    .input(
      actionScope.extend({
        credentialId: z.string().trim().min(1).max(191),
        expectedUpdatedAt: z.string().datetime({ offset: true }),
        reasonCode: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Z][A-Z0-9_]*$/u),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await revokeExternalCredentialAction(
          {
            ...input,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  listExternalCredentials: adminProcedure
    .input(
      scope.extend({
        venueId: z.string().min(1).nullable().optional(),
        cursor: cursor.optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertClientScope(input)
      const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
      const rows = await ctx.db.externalAccessCredential.findMany({
        where: {
          tenantId: input.tenantId,
          clientId: input.clientId,
          ...(input.venueId !== undefined ? { venueId: input.venueId } : {}),
          ...(input.cursor
            ? {
                OR: [
                  { createdAt: { lt: cursorDate! } },
                  { createdAt: cursorDate!, id: { lt: input.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: credentialSelect,
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
    }),

  getExternalCredential: adminProcedure
    .input(scope.extend({ credentialId: z.string().min(1), venueId: z.string().min(1).nullable() }))
    .query(async ({ ctx, input }) => {
      assertClientScope(input)
      const credential = await ctx.db.externalAccessCredential.findFirst({
        where: {
          id: input.credentialId,
          tenantId: input.tenantId,
          clientId: input.clientId,
          venueId: input.venueId,
        },
        select: {
          ...credentialSelect,
          rotationsFrom: {
            orderBy: [{ rotatedAt: 'desc' }, { id: 'desc' }],
            take: 100,
            select: { id: true, newCredentialId: true, rotatedBy: true, rotatedAt: true },
          },
          rotationsTo: {
            orderBy: [{ rotatedAt: 'desc' }, { id: 'desc' }],
            take: 100,
            select: { id: true, previousCredentialId: true, rotatedBy: true, rotatedAt: true },
          },
          revocation: { select: { id: true, revokedBy: true, reasonCode: true, revokedAt: true } },
          activation: {
            select: { operationId: true, activatedBy: true, activatedAt: true },
          },
        },
      })
      if (!credential) throw new TRPCError({ code: 'NOT_FOUND', message: 'Credential not found' })
      return credential
    }),
})
