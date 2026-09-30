export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { revokeOperatorGrant } from '@pathfinder/api/operator'
import { db } from '@pathfinder/db'

import { readBoundedJsonRequest } from '../../../../lib/bounded-json-request'
import { guardOperatorMutation, operatorJson } from '../../../../lib/operator-session'

const Body = z.object({ grantId: z.string().trim().min(1).max(191) }).strict()

/**
 * Revokes one connection from the dashboard. The grant and every token minted under it stop
 * working at once, and the audit row names the admin who did it.
 */
export async function POST(request: Request) {
  const guard = await guardOperatorMutation(request)
  if ('response' in guard) return guard.response
  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await readBoundedJsonRequest(request, { maxBytes: 1024 }))
  } catch {
    return operatorJson(400, { error: 'INVALID_REQUEST' })
  }
  const grant = await db.operatorGrant.findUnique({
    where: { id: body.grantId },
    select: { id: true },
  })
  if (!grant) return operatorJson(404, { error: 'NOT_FOUND' })
  await revokeOperatorGrant({
    grantId: grant.id,
    reason: 'dashboard_revoke',
    now: new Date(),
    requestId: randomUUID(),
    actorUserId: guard.userId,
  })
  return operatorJson(200, { grantId: grant.id, revoked: true })
}
