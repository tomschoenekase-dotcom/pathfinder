import { auth, currentUser } from '@clerk/nextjs/server'

export type TenantRole = 'STAFF' | 'MANAGER' | 'OWNER'

export type SessionContext = {
  userId: string
  activeTenantId: string | null
  role: TenantRole | null
  isPlatformAdmin: boolean
}

type PlatformRoleMetadata = {
  platform_role?: unknown
}

const CLERK_ORG_ROLE_TO_TENANT_ROLE: Record<string, TenantRole> = {
  // Clerk default organization roles are coarse; map them to the highest
  // matching tenant role until custom org roles are introduced later.
  'org:admin': 'OWNER',
  'org:manager': 'MANAGER',
  'org:member': 'STAFF',
  'org:owner': 'OWNER',
}

function mapClerkOrgRole(orgRole: string | null): TenantRole | null {
  if (orgRole === null) {
    return null
  }

  return CLERK_ORG_ROLE_TO_TENANT_ROLE[orgRole] ?? null
}

export async function resolveSession(_request: Request): Promise<SessionContext | null> {
  const authState = await auth()

  if (authState.userId === null) {
    return null
  }

  const user = await currentUser()
  const publicMetadata = (user?.publicMetadata ?? {}) as PlatformRoleMetadata

  return {
    userId: authState.userId,
    activeTenantId: authState.orgId ?? null,
    isPlatformAdmin: publicMetadata.platform_role === 'PLATFORM_ADMIN',
    role: mapClerkOrgRole(authState.orgRole ?? null),
  }
}

export const sessionInternals = {
  mapClerkOrgRole,
}
