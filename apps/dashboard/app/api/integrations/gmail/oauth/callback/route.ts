import { auth } from '@clerk/nextjs/server'
import { publishCrmOperationalSignal } from '@pathfinder/db'
import { enqueueGmailSync } from '@pathfinder/jobs'
import { NextResponse, type NextRequest } from 'next/server'

import { gmailOAuthRuntime } from '../../../../../../lib/gmail-oauth-runtime'

function result(request: NextRequest, status: 'connected' | 'failed') {
  return NextResponse.redirect(
    new URL(`/admin/prospects/outreach?gmail=${status}`, request.url),
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
    try {
      await enqueueGmailSync({ providerAccountId: account.id, trigger: 'WATCH_RENEWAL' })
      await enqueueGmailSync({
        providerAccountId: account.id,
        trigger: 'SCHEDULED_RECONCILIATION',
      })
    } catch {
      await publishCrmOperationalSignal({
        input: {
          signal: 'gmail_sync_failed',
          scope: { kind: 'platform' },
          linkedObjectType: 'CorrespondenceProviderAccount',
          linkedObjectId: account.id,
          summary: 'Gmail connected, but initial synchronization could not be queued.',
        },
      })
    }
    return result(request, 'connected')
  } catch {
    return result(request, 'failed')
  }
}
