import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

const COOKIE_NAME = 'pf_admin_tenant'
const COOKIE_MAX_AGE = 60 * 60 * 8

export async function POST(req: Request) {
  const { userId, sessionClaims } = await auth()

  if (!userId) {
    return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  }

  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'

  if (!isPlatformAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { tenantId } = (await req.json()) as { tenantId?: string | null }
  const response = NextResponse.json({ ok: true })

  if (!tenantId) {
    response.cookies.delete(COOKIE_NAME)
  } else {
    response.cookies.set(COOKIE_NAME, tenantId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })
  }

  return response
}
