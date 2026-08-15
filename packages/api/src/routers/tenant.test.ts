import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  tenantFindUnique,
  tenantMembershipFindMany,
  setTenantEngagementModeActionMock,
  inviteOrganizationMemberMock,
  listPendingOrganizationInvitationsMock,
} = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  tenantMembershipFindMany: vi.fn(),
  setTenantEngagementModeActionMock: vi.fn(),
  inviteOrganizationMemberMock: vi.fn(),
  listPendingOrganizationInvitationsMock: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  setTenantEngagementModeAction: setTenantEngagementModeActionMock,
  TenantSettingsActionError: class TenantSettingsActionError extends Error {
    constructor(
      readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
      message: string,
    ) {
      super(message)
    }
  },
}))

vi.mock('@pathfinder/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/auth')>()
  return {
    ...actual,
    inviteOrganizationMember: inviteOrganizationMemberMock,
    listPendingOrganizationInvitations: listPendingOrganizationInvitationsMock,
  }
})

import { router } from '../core'
import type { TRPCContext } from '../context'
import { tenantRouter } from './tenant'

const baseCtx = {
  db: {
    tenant: { findUnique: tenantFindUnique },
    tenantMembership: { findMany: tenantMembershipFindMany },
  } as unknown as TRPCContext['db'],
  headers: new Headers(),
}

function tenantCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'OWNER',
      isPlatformAdmin: false,
    },
  }
}

function staffCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_2',
      activeTenantId: 'tenant_1',
      role: 'STAFF',
      isPlatformAdmin: false,
    },
  }
}

function adminImpersonatingCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'admin_1',
      activeTenantId: 'tenant_1',
      role: null,
      isPlatformAdmin: true,
    },
  }
}

const testRouter = router({ tenant: tenantRouter })

describe('tenant router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('tenant.getSettings returns the current tenant and members', async () => {
    const tenant = {
      id: 'tenant_1',
      name: 'Pathfinder Demo',
      slug: 'pathfinder-demo',
      planTier: 'pro',
      status: 'ACTIVE',
      nextPaymentDue: new Date('2026-07-15T00:00:00.000Z'),
      engagementMode: 'BALANCED',
    }
    const members = [
      {
        id: 'membership_1',
        role: 'OWNER',
        status: 'ACTIVE',
        joinedAt: new Date('2026-06-01T00:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        user: {
          id: 'user_1',
          email: 'owner@example.com',
          fullName: 'Owner User',
          avatarUrl: null,
        },
      },
    ]

    tenantFindUnique.mockResolvedValueOnce(tenant)
    tenantMembershipFindMany.mockResolvedValueOnce(members)

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.tenant.getSettings()

    expect(result).toEqual({ tenant, members, canManageTeam: true })
    expect(tenantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant_1' },
        select: expect.objectContaining({
          id: true,
          name: true,
          slug: true,
          planTier: true,
          status: true,
          nextPaymentDue: true,
          engagementMode: true,
        }),
      }),
    )
  })

  it('tenant.getSettings tells staff they cannot manage invitations', async () => {
    tenantFindUnique.mockResolvedValueOnce({
      id: 'tenant_1',
      name: 'Pathfinder Demo',
      slug: 'pathfinder-demo',
      planTier: 'free',
      status: 'ACTIVE',
      nextPaymentDue: null,
      engagementMode: 'STOIC',
      updatedAt: new Date('2026-08-14T00:00:00.000Z'),
    })
    tenantMembershipFindMany.mockResolvedValueOnce([])

    await expect(testRouter.createCaller(staffCtx()).tenant.getSettings()).resolves.toMatchObject({
      canManageTeam: false,
    })
  })

  it('tenant.getSettings throws NOT_FOUND when the tenant is missing', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    tenantMembershipFindMany.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(tenantCtx())

    await expect(caller.tenant.getSettings()).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  it('tenant.getSettings excludes removed memberships', async () => {
    tenantFindUnique.mockResolvedValueOnce({
      id: 'tenant_1',
      name: 'Pathfinder Demo',
      slug: 'pathfinder-demo',
      planTier: 'free',
      status: 'ACTIVE',
      nextPaymentDue: null,
      engagementMode: 'STOIC',
    })
    tenantMembershipFindMany.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(tenantCtx())
    await caller.tenant.getSettings()

    expect(tenantMembershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', status: { not: 'REMOVED' } },
      }),
    )
  })

  it('tenant.inviteMember invites through the active tenant, not a client-supplied one', async () => {
    inviteOrganizationMemberMock.mockResolvedValueOnce({ id: 'invitation_1' })

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.tenant.inviteMember({
      emailAddress: 'new-member@example.com',
      role: 'org:member',
    })

    expect(result).toEqual({ id: 'invitation_1' })
    expect(inviteOrganizationMemberMock).toHaveBeenCalledWith({
      organizationId: 'tenant_1',
      emailAddress: 'new-member@example.com',
      role: 'org:member',
      inviterUserId: 'user_1',
    })
  })

  it('tenant.inviteMember allows a platform admin impersonating a tenant, regardless of their own org role', async () => {
    inviteOrganizationMemberMock.mockResolvedValueOnce({ id: 'invitation_2' })

    const caller = testRouter.createCaller(adminImpersonatingCtx())
    await caller.tenant.inviteMember({
      emailAddress: 'client-owner@example.com',
      role: 'org:admin',
    })

    expect(inviteOrganizationMemberMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'tenant_1', inviterUserId: 'admin_1' }),
    )
  })

  it('tenant.inviteMember throws FORBIDDEN for members below OWNER', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(
      caller.tenant.inviteMember({ emailAddress: 'someone@example.com', role: 'org:member' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(inviteOrganizationMemberMock).not.toHaveBeenCalled()
  })

  it('tenant.listPendingInvitations reads pending invitations for the active tenant', async () => {
    listPendingOrganizationInvitationsMock.mockResolvedValueOnce([
      { id: 'invitation_1', emailAddress: 'new-member@example.com', role: 'org:member' },
    ])

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.tenant.listPendingInvitations()

    expect(result).toEqual([
      { id: 'invitation_1', emailAddress: 'new-member@example.com', role: 'org:member' },
    ])
    expect(listPendingOrganizationInvitationsMock).toHaveBeenCalledWith('tenant_1')
  })

  it('tenant.listPendingInvitations hides team invitations from members below OWNER', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(caller.tenant.listPendingInvitations()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(listPendingOrganizationInvitationsMock).not.toHaveBeenCalled()
  })

  it('tenant.setEngagementMode updates the current tenant mode', async () => {
    const updatedAt = new Date('2026-08-11T15:00:01.000Z')
    setTenantEngagementModeActionMock.mockResolvedValueOnce({
      id: 'tenant_1',
      engagementMode: 'CURIOUS',
      updatedAt,
      replayed: false,
    })

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.tenant.setEngagementMode({
      mode: 'CURIOUS',
      expectedUpdatedAt: new Date('2026-08-11T15:00:00.000Z'),
    })

    expect(result).toEqual({
      id: 'tenant_1',
      engagementMode: 'CURIOUS',
      updatedAt,
      replayed: false,
    })
    expect(setTenantEngagementModeActionMock).toHaveBeenCalledWith({
      db: baseCtx.db,
      tenantId: 'tenant_1',
      mode: 'CURIOUS',
      expectedUpdatedAt: new Date('2026-08-11T15:00:00.000Z'),
      actor: { type: 'HUMAN', id: 'user_1', role: 'OWNER' },
    })
  })

  it('tenant.setEngagementMode maps a stale canonical action to CONFLICT', async () => {
    const { TenantSettingsActionError } = await import('@pathfinder/db')
    setTenantEngagementModeActionMock.mockRejectedValueOnce(
      new TenantSettingsActionError('CONFLICT', 'Tenant settings changed; refresh and try again.'),
    )

    const caller = testRouter.createCaller(tenantCtx())
    await expect(
      caller.tenant.setEngagementMode({
        mode: 'CURIOUS',
        expectedUpdatedAt: new Date('2026-08-11T15:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
