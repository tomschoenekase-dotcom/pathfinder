import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import {
  listOperatorAudit,
  listOperatorConnections,
  listOperatorInbox,
  loadOperatorReview,
} from '../../operator/admin-queries'
import { readAutonomyPolicies } from '../../operator/autonomy'
import { resolveOperatorConfig } from '../../operator/config'
import { adminProcedure } from '../../trpc'

/**
 * Read-only views for /admin/operator and /approve/[id]. State changes (approve, reject, autonomy,
 * revoke) are deliberately not tRPC mutations: they go through the guarded route handlers under
 * /api/operator so the allowlist, same-origin check and strict reverification always apply.
 */
function assertOperatorReady(ctx: { session: { userId: string | null } }) {
  const resolution = resolveOperatorConfig()
  // Platform admin alone is not enough: operator data is for allowlisted approvers only.
  if (
    resolution.status !== 'ready' ||
    !ctx.session.userId ||
    !resolution.config.allowedUserIds.has(ctx.session.userId)
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
  }
}

const auditEventTypes = [
  'mcp.call',
  'mcp.denied',
  'oauth.register',
  'oauth.arm',
  'oauth.authorize',
  'oauth.token',
  'oauth.refresh',
  'oauth.reuse_detected',
  'oauth.revoke',
  'proposal.transition',
  'plan.transition',
  'autonomy.change',
] as const

export const adminOperatorRouter = router({
  operatorAudit: adminProcedure
    .input(
      z
        .object({
          eventType: z.enum(auditEventTypes).optional(),
          outcome: z.string().trim().min(1).max(64).optional(),
          tool: z.string().trim().min(1).max(120).optional(),
          days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).optional(),
        })
        .strict(),
    )
    .query(({ input, ctx }) => {
      assertOperatorReady(ctx)
      return listOperatorAudit(input, new Date())
    }),

  operatorAutonomy: adminProcedure.query(({ ctx }) => {
    assertOperatorReady(ctx)
    return readAutonomyPolicies()
  }),

  operatorConnections: adminProcedure.query(({ ctx }) => {
    assertOperatorReady(ctx)
    return listOperatorConnections(new Date())
  }),

  operatorInbox: adminProcedure.query(({ ctx }) => {
    assertOperatorReady(ctx)
    return listOperatorInbox(new Date())
  }),

  operatorReview: adminProcedure
    .input(z.object({ id: z.string().trim().min(1).max(191) }).strict())
    .query(async ({ input, ctx }) => {
      assertOperatorReady(ctx)
      const review = await loadOperatorReview(input.id)
      if (!review) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
      return review
    }),
})
