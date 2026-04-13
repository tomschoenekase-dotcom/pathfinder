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

export async function createTRPCContext({ req }: { req: Request }): Promise<TRPCContext> {
  const session = (await resolveSession(req)) ?? ANONYMOUS_SESSION

  return {
    db,
    headers: req.headers,
    session,
  }
}
