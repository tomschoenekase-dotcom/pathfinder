import { db } from '@pathfinder/db'
import { resolveSession, type SessionContext } from '@pathfinder/auth'

export type AnonymousSessionContext = {
  userId: null
  activeTenantId: null
  role: null
  isPlatformAdmin: false
}

export type TRPCSessionContext = SessionContext | AnonymousSessionContext

export type TRPCContext = {
  db: typeof db
  headers: Headers
  session: TRPCSessionContext
}

const ANONYMOUS_SESSION: AnonymousSessionContext = {
  userId: null,
  activeTenantId: null,
  role: null,
  isPlatformAdmin: false,
}

function getCookieValue(headers: Headers, name: string): string | null {
  const cookieHeader = headers.get('cookie')

  if (!cookieHeader) {
    return null
  }

  for (const cookie of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = cookie.trim().split('=')
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join('='))
    }
  }

  return null
}

export async function createTRPCContext({ req }: { req: Request }): Promise<TRPCContext> {
  const resolvedSession = await resolveSession(req)
  const adminTenantOverride =
    resolvedSession?.isPlatformAdmin === true
      ? getCookieValue(req.headers, 'pf_admin_tenant')
      : null
  const session = resolvedSession
    ? { ...resolvedSession, activeTenantId: adminTenantOverride ?? resolvedSession.activeTenantId }
    : ANONYMOUS_SESSION

  return {
    db,
    headers: req.headers,
    session,
  }
}
