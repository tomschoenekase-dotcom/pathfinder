export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { completeAuthorization, ConsentDecision } from '@pathfinder/api/operator'

import { readBoundedJsonRequest } from '../../../../lib/bounded-json-request'
import { guardOperatorMutation, operatorJson } from '../../../../lib/operator-session'

const Body = z
  .object({
    params: z.record(z.string().max(2_048)).refine((value) => Object.keys(value).length <= 20),
    decision: ConsentDecision,
  })
  .strict()

/** Consent for a Dot connection. Allowlisted platform admin plus strict reverification. */
export async function POST(request: Request) {
  const guard = await guardOperatorMutation(request)
  if ('response' in guard) return guard.response
  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await readBoundedJsonRequest(request, { maxBytes: 16 * 1024 }))
  } catch {
    return operatorJson(400, { error: 'INVALID_REQUEST' })
  }
  const outcome = await completeAuthorization({
    config: guard.config,
    userId: guard.userId,
    params: body.params,
    decision: body.decision,
    now: new Date(),
    requestId: randomUUID(),
  })
  if ('error' in outcome) return operatorJson(400, { error: outcome.error })
  return operatorJson(200, { redirectTo: outcome.redirectTo })
}
