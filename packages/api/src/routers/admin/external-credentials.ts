import { TRPCError } from '@trpc/server'
import { z } from 'zod'

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

export const adminExternalCredentialsRouter = router({
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
        },
      })
      if (!credential) throw new TRPCError({ code: 'NOT_FOUND', message: 'Credential not found' })
      return credential
    }),
})
