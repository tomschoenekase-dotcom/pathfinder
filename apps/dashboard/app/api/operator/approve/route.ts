export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  approveAndApplyPlan,
  approveAndApplyProposal,
  createOperatorRegistry,
  OperatorNotFoundError,
  OperatorProposalError,
  rejectPlan,
  rejectProposal,
} from '@pathfinder/api/operator'
import { db } from '@pathfinder/db'

import { readBoundedJsonRequest } from '../../../../lib/bounded-json-request'
import { guardOperatorMutation, operatorJson } from '../../../../lib/operator-session'

const Body = z
  .object({
    id: z.string().trim().min(1).max(191),
    argsHash: z.string().regex(/^[0-9a-f]{64}$/u),
    decision: z.enum(['approve', 'reject']),
  })
  .strict()

/**
 * One-tap approval. The POST is bound to the argsHash Tom saw, so a proposal that changed since
 * the page rendered is refused; a replayed POST returns the current state and applies nothing.
 */
export async function POST(request: Request) {
  const guard = await guardOperatorMutation(request)
  if ('response' in guard) return guard.response
  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await readBoundedJsonRequest(request, { maxBytes: 4 * 1024 }))
  } catch {
    return operatorJson(400, { error: 'INVALID_REQUEST' })
  }
  const context = { actorUserId: guard.userId, requestId: randomUUID(), now: new Date() }
  const dependencies = {
    database: db,
    kinds: createOperatorRegistry().kinds,
    allowedUserIds: guard.config.allowedUserIds,
  }
  try {
    const plan = await db.operatorPlan.findUnique({ where: { id: body.id }, select: { id: true } })
    if (plan) {
      const row =
        body.decision === 'approve'
          ? await approveAndApplyPlan(
              { planId: body.id, argsHash: body.argsHash, ...context },
              dependencies,
            )
          : await rejectPlan({ planId: body.id, ...context })
      return operatorJson(200, { id: row.id, status: row.status })
    }
    const row =
      body.decision === 'approve'
        ? await approveAndApplyProposal(
            { proposalId: body.id, argsHash: body.argsHash, ...context },
            dependencies,
          )
        : await rejectProposal({ proposalId: body.id, ...context })
    return operatorJson(200, { id: row.id, status: row.status, failureCode: row.failureCode })
  } catch (error) {
    if (error instanceof OperatorNotFoundError) return operatorJson(404, { error: 'NOT_FOUND' })
    if (error instanceof OperatorProposalError) return operatorJson(409, { error: error.code })
    throw error
  }
}
