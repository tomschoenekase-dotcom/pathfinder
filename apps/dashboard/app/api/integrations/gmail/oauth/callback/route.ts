import { auth } from '@pathfinder/auth/server'
import { publishCrmOperationalSignal } from '@pathfinder/db'
import { enqueueGmailSync } from '@pathfinder/jobs'
import { NextResponse, type NextRequest } from 'next/server'

import { gmailOAuthRuntime } from '../../../../../../lib/gmail-oauth-runtime'

function result(
  request: NextRequest,
  status: 'connected' | 'failed',
  sync?: 'queued' | 'queue-failed',
) {
  const path = `/admin/prospects/outreach?gmail=${status}${sync ? `&sync=${sync}` : ''}`
  return NextResponse.redirect(
    new URL(path, process.env.GMAIL_OAUTH_REDIRECT_URI ?? request.url),
    303,
  )
}

export async function GET(request: NextRequest) {
  const { userId, sessionClaims } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  if (!isPlatformAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const state = request.nextUrl.searchParams.get('state')
  const code = request.nextUrl.searchParams.get('code')
  if (!state || state.length > 500 || !code || code.length > 4_000) return result(request, 'failed')
  const runtime = gmailOAuthRuntime()
  if (!runtime) return result(request, 'failed')
  try {
    const account = await runtime.complete({ state, code, requestedBy: userId })
    const [watch, reconciliation] = await Promise.allSettled([
      enqueueGmailSync({ providerAccountId: account.id, trigger: 'WATCH_RENEWAL' }),
      enqueueGmailSync({
        providerAccountId: account.id,
        trigger: 'SCHEDULED_RECONCILIATION',
      }),
    ])
    const failed = watch.status === 'rejected' || reconciliation.status === 'rejected'
    if (failed) {
      const failedWork = [
        ...(watch.status === 'rejected' ? ['watch renewal'] : []),
        ...(reconciliation.status === 'rejected' ? ['initial reconciliation'] : []),
      ].join(' and ')
      try {
        await publishCrmOperationalSignal({
          input: {
            signal: 'gmail_sync_failed',
            scope: { kind: 'platform' },
            linkedObjectType: 'CorrespondenceProviderAccount',
            linkedObjectId: account.id,
            summary: `Gmail connected, but ${failedWork} could not be queued.`,
          },
        })
      } catch {
        // OAuth completion remains successful even if operational signaling is unavailable.
      }
    }
    return result(request, 'connected', failed ? 'queue-failed' : 'queued')
  } catch {
    return result(request, 'failed')
  }
}
