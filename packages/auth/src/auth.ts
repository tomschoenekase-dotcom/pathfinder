import { auth as clerkAuth } from '@clerk/nextjs/server'
import {
  applicationTenantId,
  applicationUserId,
  assertClerkSessionBinding,
} from './identity-binding'

/** Only verified server authentication may enter the application ID namespace. */
type ProviderAuth = Awaited<ReturnType<typeof clerkAuth>>
type ApplicationAuth = {
  userId: string | null
  orgId: string | null
  orgRole: ProviderAuth['orgRole']
  sessionClaims: ProviderAuth['sessionClaims']
}

export async function auth(): Promise<ApplicationAuth> {
  const state = await clerkAuth()
  if (state.userId) assertClerkSessionBinding(state.sessionClaims)
  return {
    userId: state.userId ? applicationUserId(state.userId) : null,
    orgId: state.userId && state.orgId ? applicationTenantId(state.orgId) : null,
    orgRole: state.orgRole,
    sessionClaims: state.sessionClaims,
  }
}

/**
 * True only when Clerk confirms a strict reverification (a fresh first- or second-factor check,
 * e.g. Face ID or a passkey) for this session. Fails closed where the provider has no `has`.
 */
export async function hasStrictReverification(): Promise<boolean> {
  const state = (await clerkAuth()) as unknown as {
    userId: string | null
    has?: (params: { reverification: 'strict' }) => boolean
  }
  return (
    state.userId !== null &&
    typeof state.has === 'function' &&
    state.has({ reverification: 'strict' }) === true
  )
}

/** Clerk's reverification hint body, understood by the `useReverification` client hook. */
export function strictReverificationRequiredBody() {
  return {
    clerk_error: {
      type: 'forbidden',
      reason: 'reverification-error',
      metadata: { reverification: 'strict' },
    },
  } as const
}
