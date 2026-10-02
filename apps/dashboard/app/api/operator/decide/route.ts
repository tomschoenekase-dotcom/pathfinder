export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  createOperatorRegistry,
  decideRequest,
  OperatorNotFoundError,
  OperatorProposalError,
} from '@pathfinder/api/operator'
import { db } from '@pathfinder/db'

import { readBoundedJsonRequest } from '../../../../lib/bounded-json-request'
import { guardOperatorMutation, operatorJson } from '../../../../lib/operator-session'

const Body = z
  .object({
    decisionRequestId: z.string().trim().min(1).max(191),
    argsHash: z.string().regex(/^[0-9a-f]{64}$/u),
    decision: z.enum(['approve', 'reject']),
  })
  .strict()

/**
 * Decides one chat approval request. Only a signed-in, allowlisted platform admin who passes the
 * same-origin check and a strict reverification gets this far; the operator connection (a bearer
 * token on /api/operator/mcp) has no way to reach this route. The request is single use, short
 * lived and bound to the exact proposal version the person was shown, so a replay, a stale page or
 * a changed proposal is refused and applies nothing.
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
  try {
    const row = await decideRequest(
      {
        decisionRequestId: body.decisionRequestId,
        argsHash: body.argsHash,
        decision: body.decision,
        actorUserId: guard.userId,
        requestId: randomUUID(),
        now: new Date(),
      },
      {
        database: db,
        kinds: createOperatorRegistry().kinds,
        allowedUserIds: guard.config.allowedUserIds,
      },
    )
    return operatorJson(200, { id: row.id, status: row.status, failureCode: row.failureCode })
  } catch (error) {
    if (error instanceof OperatorNotFoundError) return operatorJson(404, { error: 'NOT_FOUND' })
    if (error instanceof OperatorProposalError) {
      return operatorJson(error.code === 'FORBIDDEN_ACTOR' ? 403 : 409, { error: error.code })
    }
    throw error
  }
}
