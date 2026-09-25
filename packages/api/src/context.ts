import { db } from '@pathfinder/db'
import { resolveSession, type SessionContext } from '@pathfinder/auth'
import type { GmailApiDraft } from './correspondence/gmail'

export type GmailDraftReadInput = Readonly<{
  credentialReferenceId: string
  mailboxAddress: string
  providerDraftId: string
}>
export type GmailDraftReadResult = GmailApiDraft & Readonly<{ authenticatedMailboxAddress: string }>
export type GmailDraftReader = (input: GmailDraftReadInput) => Promise<GmailDraftReadResult>

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
  /** Server-injected read-only provider access; absent in tests and non-dashboard hosts. */
  gmailDraftReader?: GmailDraftReader | null | undefined
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

export async function createTRPCContext({
  req,
  gmailDraftReader = null,
}: {
  req: Request
  gmailDraftReader?: GmailDraftReader | null
}): Promise<TRPCContext> {
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
    gmailDraftReader,
  }
}
