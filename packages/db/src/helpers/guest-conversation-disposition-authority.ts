import { createHash } from 'node:crypto'
import { z } from 'zod'

import { resolveGuestConversationDispositionPolicy } from '@pathfinder/config/guest-conversation-disposition-policy'
import {
  GuestConversationDispositionRequest,
  type GuestConversationDispositionAuthoritySnapshot,
} from '@pathfinder/contracts'

import { db } from '../client'
import { recordGuestConversationDispositionAuthorization } from './guest-conversation-disposition'
import { canTenantActorAccessSupportRequest } from './support-request-access'
import { lockSupportRequest } from './support-request-lock'

const scopedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/u)

/** This envelope is accepted only by the authenticated platform-admin action.
 * The case reference is an opaque handle to retained operator evidence, never prose.
 * An operator explicitly selects a requester/participant and binds one guest session;
 * the Support ACL itself does not prove anonymous visitor identity.
 */
export const GuestConversationDispositionAuthorizationInput = z
  .object({
    request: GuestConversationDispositionRequest,
    assessment: z
      .object({
        tenantId: scopedId,
        venueId: scopedId,
        sessionId: scopedId,
        caseReference: scopedId,
        holdStatus: z.enum(['NO_KNOWN_HOLD', 'HOLD_PRESENT', 'UNRESOLVED']),
        linkage: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('RETENTION_EXPIRY') }).strict(),
          z
            .object({
              kind: z.literal('SUPPORT_REQUEST'),
              supportRequestId: scopedId,
              reviewedRequesterUserId: scopedId,
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict()

export class GuestConversationDispositionAuthorityError extends Error {
  constructor(
    readonly code:
      | 'AUTHORITY_NOT_RESOLVED'
      | 'POLICY_NOT_RESOLVED'
      | 'SCOPE_NOT_FOUND'
      | 'SUPPORT_REQUEST_CHANGED'
      | 'HOLD_UNRESOLVED'
      | 'LEGAL_HOLD',
  ) {
    super(code)
    this.name = 'GuestConversationDispositionAuthorityError'
  }
}

function refuse(code: GuestConversationDispositionAuthorityError['code']): never {
  throw new GuestConversationDispositionAuthorityError(code)
}

type Actor = { userId: string; isPlatformAdmin: boolean }

/** Records immutable authority only. Maintenance resolves clock/cutoff and all
 * eligibility again; no guest text, bearer token or coordinates are read here.
 * actor must come from authenticated server context, never request JSON.
 */
export async function authorizeGuestConversationDispositionAction(
  input: z.infer<typeof GuestConversationDispositionAuthorizationInput>,
  actor: Actor,
  client: Pick<typeof db, '$transaction'> = db,
) {
  if (actor.isPlatformAdmin !== true || !scopedId.safeParse(actor.userId).success)
    refuse('AUTHORITY_NOT_RESOLVED')
  const { request, assessment } = GuestConversationDispositionAuthorizationInput.parse(input)
  const policy = resolveGuestConversationDispositionPolicy(
    request.expectedPolicyVersion,
    request.expectedPolicySha256,
  )
  if (!policy) refuse('POLICY_NOT_RESOLVED')
  if (
    assessment.tenantId !== request.tenantId ||
    assessment.venueId !== request.venueId ||
    assessment.sessionId !== request.sessionId ||
    assessment.linkage.kind !== request.basis.kind
  )
    refuse('AUTHORITY_NOT_RESOLVED')
  if (assessment.holdStatus === 'UNRESOLVED') refuse('HOLD_UNRESOLVED')
  if (assessment.holdStatus === 'HOLD_PRESENT') refuse('LEGAL_HOLD')

  return client.$transaction(async (tx) => {
    let basis: GuestConversationDispositionAuthoritySnapshot['basis'] = { kind: 'RETENTION_EXPIRY' }
    if (request.basis.kind === 'SUPPORT_REQUEST') {
      const linkage = assessment.linkage
      if (
        linkage.kind !== 'SUPPORT_REQUEST' ||
        linkage.supportRequestId !== request.basis.supportRequestId
      )
        refuse('AUTHORITY_NOT_RESOLVED')
      await lockSupportRequest(tx, request.tenantId, request.basis.supportRequestId)
      const support = await tx.supportRequest.findFirst({
        where: {
          id: request.basis.supportRequestId,
          tenantId: request.tenantId,
          venueId: request.venueId,
        },
        select: {
          status: true,
          version: true,
          createdByKind: true,
          requesterUserId: true,
          requesterMembership: { select: { status: true } },
          participants: {
            where: { userId: linkage.reviewedRequesterUserId },
            select: { userId: true, revokedAt: true, membership: { select: { status: true } } },
          },
        },
      })
      if (
        !support ||
        support.status === 'DRAFT' ||
        support.status === 'CANCELLED' ||
        !['CLIENT', 'OPERATOR'].includes(support.createdByKind) ||
        !canTenantActorAccessSupportRequest(
          { actorId: linkage.reviewedRequesterUserId, role: 'STAFF' },
          support,
        )
      )
        refuse('AUTHORITY_NOT_RESOLVED')
      if (support.version !== request.basis.expectedSupportRequestVersion)
        refuse('SUPPORT_REQUEST_CHANGED')
      basis = {
        kind: 'SUPPORT_REQUEST',
        supportRequestId: request.basis.supportRequestId,
        supportRequestVersion: request.basis.expectedSupportRequestVersion,
        reviewedRequesterUserId: linkage.reviewedRequesterUserId,
      }
    }
    const session = await tx.visitorSession.findFirst({
      where: { id: request.sessionId, tenantId: request.tenantId, venueId: request.venueId },
      select: { id: true },
    })
    if (!session) refuse('SCOPE_NOT_FOUND')
    const referenceSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          domain: 'guest-disposition-scoped-operator-assessment-v1',
          actorId: actor.userId,
          assessment,
        }),
      )
      .digest('hex')
    return recordGuestConversationDispositionAuthorization(
      {
        request,
        authority: {
          version: 'guest-disposition-authority-v1',
          actorId: actor.userId,
          actorRole: 'PLATFORM_ADMIN',
          policyVersion: policy.version,
          policySha256: request.expectedPolicySha256,
          retentionDays: policy.retentionDays,
          holdAssessment: { status: 'NO_KNOWN_HOLD', referenceSha256 },
          basis,
        },
      },
      tx,
    )
  })
}
