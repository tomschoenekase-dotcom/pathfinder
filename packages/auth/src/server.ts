import { clerkClient, currentUser as clerkCurrentUser } from '@clerk/nextjs/server'
import { TRPCError } from '@trpc/server'

export async function currentUser() {
  return clerkCurrentUser()
}

export async function requireAuth() {
  const user = await clerkCurrentUser()

  if (user === null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    })
  }

  return user
}

export type CreatedOrganization = {
  id: string
  name: string
  slug: string
}

export type ValidatedOrganizationOwner = {
  organizationId: string
  userId: string
  emailAddress: string
}

// Clerk API errors carry the real reason in `.errors[].longMessage`; the
// generic top-level `.message` is often just the HTTP status text (e.g.
// "Forbidden"), which is useless on its own for diagnosing why a call failed.
function describeClerkError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'errors' in error) {
    const clerkErrors = (error as { errors?: unknown }).errors
    if (Array.isArray(clerkErrors) && clerkErrors.length > 0) {
      const [first] = clerkErrors as Array<{ message?: string; longMessage?: string }>
      const detail = first?.longMessage ?? first?.message
      if (detail) return detail
    }
  }

  return error instanceof Error ? error.message : 'Unknown Clerk error'
}

function isClerkNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as { status?: unknown; statusCode?: unknown }
  return candidate.status === 404 || candidate.statusCode === 404
}

function clerkValidationError(error: unknown): TRPCError {
  if (isClerkNotFoundError(error)) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The Clerk organization or owner could not be validated',
    })
  }

  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Clerk identity validation is temporarily unavailable',
  })
}

/**
 * Resolves an existing Clerk organization and the user that will become its
 * local OWNER. The local role is only safe when Clerk already grants the user
 * an owner-equivalent organization role.
 */
export async function validateExistingOrganizationOwner(input: {
  organizationId: string
  userId: string
  emailAddress: string
}): Promise<ValidatedOrganizationOwner> {
  try {
    const client = await clerkClient()
    const [organization, user, memberships] = await Promise.all([
      client.organizations.getOrganization({ organizationId: input.organizationId }),
      client.users.getUser(input.userId),
      client.organizations.getOrganizationMembershipList({
        organizationId: input.organizationId,
        userId: [input.userId],
        limit: 2,
      }),
    ])

    const membership = memberships.data.find(
      (candidate) => candidate.publicUserData?.userId === input.userId,
    )
    const emailAddress =
      user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId)
        ?.emailAddress ?? user.emailAddresses[0]?.emailAddress
    const normalizedInputEmail = input.emailAddress.trim().toLowerCase()
    const inputMatchesClerkEmail = user.emailAddresses.some(
      (address) => address.emailAddress.toLowerCase() === normalizedInputEmail,
    )

    if (
      organization.id !== input.organizationId ||
      user.id !== input.userId ||
      !membership ||
      (membership.role !== 'org:admin' && membership.role !== 'org:owner') ||
      !emailAddress ||
      !inputMatchesClerkEmail
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'The Clerk organization or owner could not be validated',
      })
    }

    return {
      organizationId: organization.id,
      userId: user.id,
      emailAddress,
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error
    throw clerkValidationError(error)
  }
}

/**
 * Creates a real Clerk Organization server-side. `createdBy` makes that user
 * an admin member of the org automatically, so a platform admin creating a
 * client this way can later switch into it (via the org picker) to use
 * Clerk-native flows like inviting the real client by email.
 *
 * `input.slug` is NOT sent to Clerk — this Clerk instance has organization
 * slugs disabled, and the self-serve onboarding flow already creates orgs
 * without one. It's only used as the fallback value for our own Tenant.slug
 * column below, which is independent of Clerk's org slug.
 */
export async function createOrganization(input: {
  name: string
  slug: string
  createdByUserId: string
}): Promise<CreatedOrganization> {
  const client = await clerkClient()

  let organization: Awaited<ReturnType<typeof client.organizations.createOrganization>>
  try {
    organization = await client.organizations.createOrganization({
      name: input.name,
      createdBy: input.createdByUserId,
    })
  } catch (error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Clerk rejected the organization creation: ${describeClerkError(error)}`,
    })
  }

  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug ?? input.slug,
  }
}

type OrganizationsApi = Awaited<ReturnType<typeof clerkClient>>['organizations']
type CreateInvitationParams = Parameters<OrganizationsApi['createOrganizationInvitation']>[0]
export type OrganizationRole = CreateInvitationParams['role']

export type PendingOrganizationInvitation = {
  id: string
  emailAddress: string
  role: string
}

/**
 * Invites someone into a Clerk Organization via the Backend API, scoped to
 * whatever `organizationId` the caller resolved server-side. Used instead of
 * Clerk's client-side `organization.inviteMember()` so invites work
 * correctly when a platform admin is viewing a tenant via impersonation
 * (where the browser's real active Clerk org is NOT the impersonated one).
 */
export async function inviteOrganizationMember(input: {
  organizationId: string
  emailAddress: string
  role: OrganizationRole
  inviterUserId: string
}): Promise<{ id: string }> {
  const client = await clerkClient()

  try {
    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: input.organizationId,
      emailAddress: input.emailAddress,
      role: input.role,
      inviterUserId: input.inviterUserId,
    })

    return { id: invitation.id }
  } catch (error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Clerk rejected the invitation: ${describeClerkError(error)}`,
    })
  }
}

export async function listPendingOrganizationInvitations(
  organizationId: string,
): Promise<PendingOrganizationInvitation[]> {
  const client = await clerkClient()
  const { data } = await client.organizations.getOrganizationInvitationList({
    organizationId,
    status: ['pending'],
  })

  return data.map((invitation) => ({
    id: invitation.id,
    emailAddress: invitation.emailAddress,
    role: invitation.role,
  }))
}
