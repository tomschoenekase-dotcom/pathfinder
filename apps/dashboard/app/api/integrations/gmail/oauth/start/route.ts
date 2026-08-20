import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import { gmailOAuthRuntime } from '../../../../../../lib/gmail-oauth-runtime'

export async function GET() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  if (!isPlatformAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const runtime = gmailOAuthRuntime()
  if (!runtime)
    return NextResponse.json({ error: 'Gmail OAuth is not configured' }, { status: 503 })
  return NextResponse.redirect(await runtime.begin(userId), 303)
}
