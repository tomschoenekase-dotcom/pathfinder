import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  clerkClientMock,
  createOrganizationInvitation,
  getOrganization,
  getOrganizationInvitationList,
  getOrganizationMembershipList,
  getUser,
} = vi.hoisted(() => ({
  clerkClientMock: vi.fn(),
  createOrganizationInvitation: vi.fn(),
  getOrganization: vi.fn(),
  getOrganizationInvitationList: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
  getUser: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: clerkClientMock,
  currentUser: vi.fn(),
}))

import { ensureOrganizationInvitation, validateExistingOrganizationOwner } from './server'

const input = {
  organizationId: 'org_1',
  userId: 'user_1',
  emailAddress: 'owner@example.com',
}

describe('validateExistingOrganizationOwner', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clerkClientMock.mockResolvedValue({
      organizations: {
        createOrganizationInvitation,
        getOrganization,
        getOrganizationInvitationList,
        getOrganizationMembershipList,
      },
      users: { getUser },
    })
    getOrganization.mockResolvedValue({ id: 'org_1', name: 'Organization One', slug: 'org-one' })
    getUser.mockResolvedValue({
      id: 'user_1',
      primaryEmailAddressId: 'email_primary',
      emailAddresses: [
        { id: 'email_secondary', emailAddress: 'other@example.com' },
        { id: 'email_primary', emailAddress: 'Owner@Example.com' },
      ],
    })
    getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          role: 'org:admin',
          publicUserData: { userId: 'user_1' },
        },
      ],
    })
    getOrganizationInvitationList.mockResolvedValue({ data: [] })
    createOrganizationInvitation.mockResolvedValue({ id: 'invite_new' })
  })

  it('returns exact Clerk identity and canonical primary email for an admin member', async () => {
    await expect(validateExistingOrganizationOwner(input)).resolves.toEqual({
      organizationId: 'org_1',
      organizationName: 'Organization One',
      organizationSlug: 'org-one',
      userId: 'user_1',
      emailAddress: 'Owner@Example.com',
    })

    expect(getOrganization).toHaveBeenCalledWith({ organizationId: 'org_1' })
    expect(getUser).toHaveBeenCalledWith('user_1')
    expect(getOrganizationMembershipList).toHaveBeenCalledWith({
      organizationId: 'org_1',
      userId: ['user_1'],
      limit: 2,
    })
  })

  it('accepts Clerk owner role as owner-equivalent', async () => {
    getOrganizationMembershipList.mockResolvedValueOnce({
      data: [{ role: 'org:owner', publicUserData: { userId: 'user_1' } }],
    })

    await expect(validateExistingOrganizationOwner(input)).resolves.toMatchObject({
      userId: 'user_1',
    })
  })

  it('accepts an attached secondary email while returning the canonical primary email', async () => {
    await expect(
      validateExistingOrganizationOwner({ ...input, emailAddress: 'other@example.com' }),
    ).resolves.toMatchObject({ emailAddress: 'Owner@Example.com' })
  })

  it.each([
    [
      'a mismatched organization response',
      () => getOrganization.mockResolvedValueOnce({ id: 'org_other' }),
    ],
    [
      'a mismatched user response',
      () => getUser.mockResolvedValueOnce({ id: 'user_other', emailAddresses: [] }),
    ],
    [
      'no exact organization membership',
      () => getOrganizationMembershipList.mockResolvedValueOnce({ data: [] }),
    ],
    [
      'a non-owner Clerk membership',
      () =>
        getOrganizationMembershipList.mockResolvedValueOnce({
          data: [{ role: 'org:member', publicUserData: { userId: 'user_1' } }],
        }),
    ],
    ['an email that does not match Clerk', () => undefined],
  ])('rejects %s', async (_description, configure) => {
    configure()
    const candidate =
      _description === 'an email that does not match Clerk'
        ? { ...input, emailAddress: 'attacker@example.com' }
        : input

    await expect(validateExistingOrganizationOwner(candidate)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The Clerk organization or owner could not be validated',
    } satisfies Partial<TRPCError>)
  })

  it('maps Clerk not-found responses to a sanitized input error', async () => {
    getOrganization.mockRejectedValueOnce({ status: 404, errors: [{ longMessage: 'private' }] })

    await expect(validateExistingOrganizationOwner(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The Clerk organization or owner could not be validated',
    } satisfies Partial<TRPCError>)
  })

  it('maps other Clerk failures to a sanitized dependency error', async () => {
    getUser.mockRejectedValueOnce(new Error('secret provider detail'))

    await expect(validateExistingOrganizationOwner(input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Clerk identity validation is temporarily unavailable',
    } satisfies Partial<TRPCError>)
  })

  it('sanitizes Clerk client initialization failures', async () => {
    clerkClientMock.mockRejectedValueOnce(new Error('secret configuration detail'))

    await expect(validateExistingOrganizationOwner(input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Clerk identity validation is temporarily unavailable',
    } satisfies Partial<TRPCError>)
  })
})

describe('ensureOrganizationInvitation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clerkClientMock.mockResolvedValue({
      organizations: { createOrganizationInvitation, getOrganizationInvitationList },
    })
    getOrganizationInvitationList.mockResolvedValue({ data: [] })
    createOrganizationInvitation.mockResolvedValue({ id: 'invite_new' })
  })

  const invitationInput = {
    organizationId: 'org_1',
    emailAddress: 'Owner@Example.com',
    role: 'org:admin' as const,
    inviterUserId: 'admin_1',
  }

  it('creates an invitation when no matching pending invitation exists', async () => {
    await expect(ensureOrganizationInvitation(invitationInput)).resolves.toEqual({
      id: 'invite_new',
      replayed: false,
    })
    expect(createOrganizationInvitation).toHaveBeenCalledWith(invitationInput)
  })

  it('reuses a case-insensitive matching pending invitation on retry', async () => {
    getOrganizationInvitationList.mockResolvedValueOnce({
      data: [{ id: 'invite_existing', emailAddress: 'owner@example.com', role: 'org:admin' }],
    })
    await expect(ensureOrganizationInvitation(invitationInput)).resolves.toEqual({
      id: 'invite_existing',
      replayed: true,
    })
    expect(createOrganizationInvitation).not.toHaveBeenCalled()
  })

  it('fails closed when the same email has a pending invitation with a different role', async () => {
    getOrganizationInvitationList.mockResolvedValueOnce({
      data: [{ id: 'invite_existing', emailAddress: 'owner@example.com', role: 'org:member' }],
    })
    await expect(ensureOrganizationInvitation(invitationInput)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(createOrganizationInvitation).not.toHaveBeenCalled()
  })
})
