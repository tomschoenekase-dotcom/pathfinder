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
