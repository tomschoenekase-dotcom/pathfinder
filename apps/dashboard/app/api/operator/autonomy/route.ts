export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  OPERATOR_LOCKED_CAPABILITIES,
  OPERATOR_POLICY_CAPABILITIES,
  OperatorAutonomyLockedError,
  setAutonomyPolicies,
} from '@pathfinder/api/operator'

import { readBoundedJsonRequest } from '../../../../lib/bounded-json-request'
import { guardOperatorMutation, operatorJson } from '../../../../lib/operator-session'

const Body = z
  .object({
    changes: z
      .array(
        z
          .object({ capability: z.string().trim().min(1).max(120), mode: z.enum(['ask', 'auto']) })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()

/**
 * Saves the autonomy switches. Allowlisted platform admin, same origin and a strict
 * reverification come first. Locked capabilities are refused here, on the server, whatever the
 * page showed; the whole batch is checked before anything is written.
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
  const changes = []
  const seen = new Set<string>()
  for (const change of body.changes) {
    const capability = OPERATOR_POLICY_CAPABILITIES.find((entry) => entry === change.capability)
    if (!capability || seen.has(capability)) return operatorJson(400, { error: 'INVALID_REQUEST' })
    seen.add(capability)
    if (change.mode === 'auto' && OPERATOR_LOCKED_CAPABILITIES.has(capability)) {
      return operatorJson(409, { error: 'AUTONOMY_LOCKED', capability })
    }
    changes.push({ capability, mode: change.mode })
  }
  const requestId = randomUUID()
  try {
    // One transaction and one policy revision for the whole batch: never half-changed.
    const { revision } = await setAutonomyPolicies({ changes, userId: guard.userId, requestId })
    return operatorJson(200, { saved: changes.length, revision })
  } catch (error) {
    if (error instanceof OperatorAutonomyLockedError) {
      return operatorJson(409, { error: 'AUTONOMY_LOCKED' })
    }
    throw error
  }
}
