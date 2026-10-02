export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  createJobGrant,
  createOperatorRegistry,
  OperatorJobGrantError,
  OperatorNotFoundError,
  revokeJobGrant,
} from '@pathfinder/api/operator'
import { db } from '@pathfinder/db'

import { readBoundedJsonRequest } from '../../../../lib/bounded-json-request'
import { guardOperatorMutation, operatorJson } from '../../../../lib/operator-session'

const Id = z.string().trim().min(1).max(191)

const Body = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      name: z.string().trim().min(1).max(120),
      clientId: z.string().trim().min(1).max(64),
      tenantId: Id,
      venueId: Id.optional(),
      kinds: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
      maxExecutions: z.number().int().min(1).max(100),
      maxAmountCents: z.number().int().min(0).max(100_000_000).optional(),
      expiresInMinutes: z
        .number()
        .int()
        .min(5)
        .max(168 * 60)
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal('revoke'), id: Id }).strict(),
])

/**
 * Creates and revokes bounded job grants. Allowlisted platform admin, same origin and a strict
 * reverification come first, exactly as for approvals; there is deliberately no operator tool that
 * reaches this. The service re-validates every bound and refuses kinds that did not opt in.
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
  const dependencies = {
    database: db,
    kinds: createOperatorRegistry().kinds,
    allowedUserIds: guard.config.allowedUserIds,
  }
  const common = { actorUserId: guard.userId, requestId: randomUUID(), now: new Date() }
  try {
    if (body.action === 'revoke') {
      const row = await revokeJobGrant({ id: body.id, ...common }, dependencies)
      return operatorJson(200, { id: row.id, revoked: row.revokedAt !== null })
    }
    const row = await createJobGrant(
      {
        name: body.name,
        clientId: body.clientId,
        tenantId: body.tenantId,
        venueId: body.venueId,
        kinds: body.kinds,
        maxExecutions: body.maxExecutions,
        maxAmountCents: body.maxAmountCents,
        expiresInMinutes: body.expiresInMinutes,
        ...common,
      },
      dependencies,
    )
    return operatorJson(200, { id: row.id, created: true })
  } catch (error) {
    if (error instanceof OperatorNotFoundError) return operatorJson(404, { error: 'NOT_FOUND' })
    if (error instanceof OperatorJobGrantError) {
      return operatorJson(error.code === 'FORBIDDEN_ACTOR' ? 403 : 409, { error: error.code })
    }
    throw error
  }
}
