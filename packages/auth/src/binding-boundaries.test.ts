import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  clerkClient: vi.fn(),
  getOrganization: vi.fn(),
  getUser: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
  createOrganization: vi.fn(),
  createOrganizationInvitation: vi.fn(),
  getOrganizationInvitationList: vi.fn(),
}))
vi.mock('@clerk/nextjs/server', () => mocks)
import {
  auth,
  currentUser,
  requireAuth,
  validateExistingOrganizationOwner,
  createOrganization,
  inviteOrganizationMember,
  listPendingOrganizationInvitations,
} from './server'
import { resolveSession } from './session'
import { requirePlatformAdmin, requireTenantRole } from './permissions'

const museums = [
  ['org_newMiniature', 'org_3HN2BNDTxN9EU5HrfMOh9gWIxao'],
  ['org_newSpace', 'org_3HV2vyn6xVr0wPRx2PAmC6AH7V2'],
] as const
const issuer = 'https://clerk.synthetic.example'
const request = new Request('https://dashboard.example')
describe('bound authenticated and outbound server boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv(
      'CLERK_IDENTITY_BINDING',
      JSON.stringify({
        version: 1,
        issuer,
        instanceId: 'ins_synthetic',
        webhookSecretSha256: 'a'.repeat(64),
        users: [{ providerId: 'user_newTom', applicationId: 'user_oldTom' }],
        organizations: museums.map(([providerId, applicationId]) => ({
          providerId,
          applicationId,
        })),
      }),
    )
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_synthetic')
    const key = `pk_live_${Buffer.from('clerk.synthetic.example$').toString('base64')}`
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', key)
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', key)
    mocks.auth.mockResolvedValue({
      userId: 'user_newTom',
      orgId: museums[0][0],
      orgRole: 'org:member',
      sessionClaims: { iss: issuer },
    })
    mocks.currentUser.mockResolvedValue({
      id: 'user_newTom',
      publicMetadata: {},
      unsafeMetadata: { applicationId: 'user_attacker', platform_role: 'PLATFORM_ADMIN' },
    })
    mocks.clerkClient.mockResolvedValue({ organizations: mocks, users: mocks })
  })
  afterEach(() => vi.unstubAllEnvs())
  it.each(museums)(
    'scopes sessions and server pages to selected %s without granting roles',
    async (providerId, applicationId) => {
      mocks.auth.mockResolvedValue({
        userId: 'user_newTom',
        orgId: providerId,
        orgRole: 'org:member',
        sessionClaims: { iss: issuer },
      })
      const session = await resolveSession(request)
      expect(session).toEqual({
        userId: 'user_oldTom',
        activeTenantId: applicationId,
        role: 'STAFF',
        isPlatformAdmin: false,
      })
      expect(await auth()).toMatchObject({ userId: 'user_oldTom', orgId: applicationId })
      expect(() => requireTenantRole(session!, 'OWNER')).toThrow()
      expect(() => requirePlatformAdmin(session!)).toThrow()
      expect((await currentUser())?.id).toBe('user_oldTom')
      expect((await requireAuth()).id).toBe('user_oldTom')
    },
  )
  it('preserves platform authority and actor identity only from trusted provider metadata', async () => {
    mocks.currentUser.mockResolvedValue({
      id: 'user_newTom',
      publicMetadata: { platform_role: 'PLATFORM_ADMIN' },
    })
    expect(await resolveSession(request)).toMatchObject({
      userId: 'user_oldTom',
      isPlatformAdmin: true,
      role: 'STAFF',
    })
  })
  it('does not infer organization membership from a user mapping', async () => {
    mocks.auth.mockResolvedValue({
      userId: 'user_newTom',
      orgId: null,
      orgRole: null,
      sessionClaims: { iss: issuer },
    })
    const session = await resolveSession(request)
    expect(session).toMatchObject({ activeTenantId: null, role: null })
    expect(() => requireTenantRole(session!, 'STAFF')).toThrow()
  })
  it('leaves new users and organizations untouched', async () => {
    mocks.auth.mockResolvedValue({
      userId: 'user_newClient',
      orgId: 'org_newClient',
      orgRole: 'org:admin',
      sessionClaims: { iss: issuer },
    })
    mocks.currentUser.mockResolvedValue({ id: 'user_newClient', publicMetadata: {} })
    expect(await resolveSession(request)).toMatchObject({
      userId: 'user_newClient',
      activeTenantId: 'org_newClient',
      role: 'OWNER',
    })
  })
  it('keeps unauthenticated requests anonymous', async () => {
    mocks.auth.mockResolvedValue({ userId: null, orgId: null })
    mocks.currentUser.mockResolvedValue(null)
    expect(await resolveSession(request)).toBeNull()
    expect(await auth()).toMatchObject({ userId: null, orgId: null })
    await expect(requireAuth()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
  it.each([
    { userId: 'user_oldTom', orgId: museums[0][0], sessionClaims: { iss: issuer } },
    { userId: 'user_newTom', orgId: museums[0][1], sessionClaims: { iss: issuer } },
    {
      userId: 'user_newTom',
      orgId: museums[0][0],
      sessionClaims: { iss: 'https://other.example' },
    },
  ])('fails closed for stale IDs and wrong issuer %#', async (state) => {
    mocks.auth.mockResolvedValue(state)
    await expect(resolveSession(request)).rejects.toThrow('binding validation failed')
    await expect(auth()).rejects.toThrow('binding validation failed')
  })
  it('uses exact inverse IDs for owner validation and retains provider role verification', async () => {
    mocks.getOrganization.mockResolvedValue({
      id: museums[0][0],
      name: 'Miniature',
      slug: 'miniature',
    })
    mocks.getUser.mockResolvedValue({
      id: 'user_newTom',
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'fixture@example.com' }],
    })
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [{ publicUserData: { userId: 'user_newTom' }, role: 'org:admin' }],
    })
    const input = {
      organizationId: museums[0][1],
      userId: 'user_oldTom',
      emailAddress: 'fixture@example.com',
    }
    expect(await validateExistingOrganizationOwner(input)).toMatchObject({
      organizationId: museums[0][1],
      userId: 'user_oldTom',
    })
    expect(mocks.getOrganization).toHaveBeenCalledWith({ organizationId: museums[0][0] })
    expect(mocks.getUser).toHaveBeenCalledWith('user_newTom')
    expect(mocks.getOrganizationMembershipList).toHaveBeenCalledWith({
      organizationId: museums[0][0],
      userId: ['user_newTom'],
      limit: 2,
    })
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [{ publicUserData: { userId: 'user_newTom' }, role: 'org:member' }],
    })
    await expect(validateExistingOrganizationOwner(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })
  it('translates organization creation and invitations without real provider calls', async () => {
    mocks.createOrganization.mockResolvedValue({ id: 'org_newClient', name: 'Client', slug: null })
    expect(
      await createOrganization({ name: 'Client', slug: 'client', createdByUserId: 'user_oldTom' }),
    ).toMatchObject({ id: 'org_newClient' })
    expect(mocks.createOrganization).toHaveBeenCalledWith({
      name: 'Client',
      createdBy: 'user_newTom',
    })
    mocks.createOrganizationInvitation.mockResolvedValue({ id: 'invite_fixture' })
    mocks.getOrganizationInvitationList.mockResolvedValue({ data: [] })
    for (const [providerId, applicationId] of museums) {
      await inviteOrganizationMember({
        organizationId: applicationId,
        inviterUserId: 'user_oldTom',
        emailAddress: 'fixture@example.com',
        role: 'org:member',
      })
      expect(mocks.createOrganizationInvitation).toHaveBeenLastCalledWith({
        organizationId: providerId,
        inviterUserId: 'user_newTom',
        emailAddress: 'fixture@example.com',
        role: 'org:member',
      })
      await listPendingOrganizationInvitations(applicationId)
      expect(mocks.getOrganizationInvitationList).toHaveBeenLastCalledWith({
        organizationId: providerId,
        status: ['pending'],
      })
    }
  })
})
