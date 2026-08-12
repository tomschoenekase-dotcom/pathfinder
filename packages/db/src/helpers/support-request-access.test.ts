import { describe, expect, it } from 'vitest'

import {
  canTenantActorAccessSupportRequest,
  tenantSupportRequestAccessWhere,
} from './support-request-access'

const actor = { actorId: 'user_1', role: 'STAFF' as const }

describe('tenant support request ACL', () => {
  it.each(['STAFF', 'MANAGER', 'OWNER'] as const)(
    'does not widen requester-or-participant access for %s',
    (role) => {
      expect(tenantSupportRequestAccessWhere({ ...actor, role })).toEqual(
        tenantSupportRequestAccessWhere(actor),
      )
    },
  )

  it('requires exact active requester or active unrevoked participant membership', () => {
    const base = {
      createdByKind: 'CLIENT',
      requesterUserId: 'requester',
      requesterMembership: { status: 'ACTIVE' },
      participants: [] as Array<{
        userId: string
        revokedAt: Date | null
        membership: { status: string }
      }>,
    }
    expect(canTenantActorAccessSupportRequest(actor, { ...base, requesterUserId: 'user_1' })).toBe(
      true,
    )
    expect(
      canTenantActorAccessSupportRequest(actor, {
        ...base,
        requesterUserId: 'user_1',
        requesterMembership: { status: 'SUSPENDED' },
      }),
    ).toBe(false)
    expect(
      canTenantActorAccessSupportRequest(actor, {
        ...base,
        participants: [{ userId: 'user_1', revokedAt: null, membership: { status: 'ACTIVE' } }],
      }),
    ).toBe(true)
    expect(
      canTenantActorAccessSupportRequest(actor, {
        ...base,
        participants: [
          { userId: 'user_1', revokedAt: new Date(), membership: { status: 'ACTIVE' } },
        ],
      }),
    ).toBe(false)
    expect(
      canTenantActorAccessSupportRequest(actor, {
        ...base,
        participants: [{ userId: 'user_1', revokedAt: null, membership: { status: 'SUSPENDED' } }],
      }),
    ).toBe(false)
  })
})
