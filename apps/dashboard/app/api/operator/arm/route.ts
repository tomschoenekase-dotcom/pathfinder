export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { randomUUID } from 'node:crypto'

import { armOperatorConnection } from '@pathfinder/api/operator'

import { guardOperatorMutation, operatorJson } from '../../../../lib/operator-session'

/** Tom says "I am connecting now"; consent is accepted only within ten minutes of this. */
export async function POST(request: Request) {
  const guard = await guardOperatorMutation(request)
  if ('response' in guard) return guard.response
  await armOperatorConnection({ userId: guard.userId, requestId: randomUUID() })
  return operatorJson(200, { armed: true })
}
