import { z } from 'zod'
import {
  GuestConversationDispositionAuthoritySnapshot,
  GuestConversationDispositionRequest,
} from '@pathfinder/contracts/guest-conversation-disposition'

import { db } from '../client'

export type { GuestConversationDispositionAuthoritySnapshot } from '@pathfinder/contracts/guest-conversation-disposition'

type QueryClient = Pick<typeof db, '$queryRaw'>

const authorizationReceipt = z
  .object({
    operationId: z.string().uuid(),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    state: z.enum(['AUTHORIZED', 'FENCED', 'APPLIED']),
    authorizedAt: z.string().datetime({ offset: true }),
    replayed: z.boolean(),
  })
  .strict()

/** Internal persistence seam. Only the authenticated authority resolver may
 * construct the authority snapshot. This function grants no maintenance power.
 */
export async function recordGuestConversationDispositionAuthorization(
  input: {
    request: GuestConversationDispositionRequest
    authority: GuestConversationDispositionAuthoritySnapshot
  },
  client: QueryClient = db,
) {
  const request = GuestConversationDispositionRequest.parse(input.request)
  const authority = GuestConversationDispositionAuthoritySnapshot.parse(input.authority)
  if (
    request.expectedPolicyVersion !== authority.policyVersion ||
    request.expectedPolicySha256 !== authority.policySha256 ||
    request.basis.kind !== authority.basis.kind ||
    (request.basis.kind === 'SUPPORT_REQUEST' &&
      (authority.basis.kind !== 'SUPPORT_REQUEST' ||
        request.basis.supportRequestId !== authority.basis.supportRequestId ||
        request.basis.expectedSupportRequestVersion !== authority.basis.supportRequestVersion))
  ) {
    throw new Error('Guest disposition authority does not match the request.')
  }
  const rows = await client.$queryRaw<Array<{ result: unknown }>>`
    SELECT public.pathfinder_authorize_guest_disposition(
      ${JSON.stringify(request)}::jsonb, ${JSON.stringify(authority)}::jsonb
    ) AS result
  `
  if (rows.length !== 1) throw new Error('Guest disposition authorization receipt is missing.')
  return authorizationReceipt.parse(rows[0]?.result)
}

/** A read guard for callers before token lookup, replay and hash projection.
 * PostgreSQL row guards remain authoritative against ordinary late writes.
 */
export async function isGuestConversationDisposed(
  input: { tenantId: string; venueId: string; sessionId?: string; anonymousToken?: string },
  client: QueryClient = db,
): Promise<boolean> {
  const scope = z
    .object({
      tenantId: z.string().min(1).max(191),
      venueId: z.string().min(1).max(191),
      sessionId: z.string().min(1).max(191).optional(),
      anonymousToken: z.string().min(1).max(191).optional(),
    })
    .strict()
    .refine((value) => Boolean(value.sessionId || value.anonymousToken))
    .parse(input)
  const rows = await client.$queryRaw<Array<{ disposed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM public.guest_conversation_disposition_operations
      WHERE tenant_id = ${scope.tenantId} AND venue_id = ${scope.venueId}
        AND state IN ('FENCED', 'APPLIED')
        AND (
          session_id = ${scope.sessionId ?? null}
          OR retired_token_digest = public.pathfinder_guest_disposition_token_digest(
            ${scope.tenantId}, ${scope.venueId}, ${scope.anonymousToken ?? null}
          )
        )
    ) AS disposed
  `
  if (rows.length !== 1 || typeof rows[0]?.disposed !== 'boolean') {
    throw new Error('Guest disposition read guard failed.')
  }
  return rows[0].disposed
}
