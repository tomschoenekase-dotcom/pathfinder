export type TenantSupportRole = 'STAFF' | 'MANAGER' | 'OWNER'

export type TenantSupportActor = {
  actorId: string
  role: TenantSupportRole
}

export type SupportRequesterIdentity = {
  createdByKind: string
  requesterUserId: string | null
  requesterMembership: { status: string } | null
  participants: Array<{ userId: string; revokedAt: Date | null; membership: { status: string } }>
}

/**
 * Every tenant role uses the same requester-or-explicit-participant ACL.
 * Role hierarchy never widens Support privacy.
 */
export function tenantSupportRequestAccessWhere(actor: TenantSupportActor) {
  return {
    OR: [
      {
        createdByKind: 'CLIENT' as const,
        requesterUserId: actor.actorId,
        requesterMembership: { is: { status: 'ACTIVE' as const } },
      },
      {
        participants: {
          some: {
            userId: actor.actorId,
            revokedAt: null,
            membership: { is: { status: 'ACTIVE' as const } },
          },
        },
      },
    ],
  }
}

export function canTenantActorAccessSupportRequest(
  actor: TenantSupportActor,
  request: SupportRequesterIdentity,
): boolean {
  return (
    (request.createdByKind === 'CLIENT' &&
      request.requesterUserId === actor.actorId &&
      request.requesterMembership?.status === 'ACTIVE') ||
    request.participants.some(
      (participant) =>
        participant.userId === actor.actorId &&
        participant.revokedAt === null &&
        participant.membership.status === 'ACTIVE',
    )
  )
}
