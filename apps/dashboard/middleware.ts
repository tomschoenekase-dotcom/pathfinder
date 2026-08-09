import { clerkMiddleware } from '@clerk/nextjs/server'
import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'

import { isPublicDashboardPath, resolveDashboardAccess } from './lib/middleware-access'

export default clerkMiddleware(async (auth, req) => {
  try {
    const { pathname } = req.nextUrl

    if (isPublicDashboardPath(pathname)) return NextResponse.next()

    const authState = await auth()
    const adminTenantOverride = req.cookies.get('pf_admin_tenant')?.value
    const decision = resolveDashboardAccess({
      pathname,
      userId: authState.userId,
      orgId: authState.orgId,
      platformRole: (
        authState.sessionClaims?.publicMetadata as { platform_role?: unknown } | undefined
      )?.platform_role,
      adminTenantOverride,
    })

    if (decision === 'sign-in') return authState.redirectToSignIn()
    if (decision === 'root') return NextResponse.redirect(new URL('/', req.url))
    if (decision === 'onboarding') {
      return NextResponse.redirect(new URL('/onboarding', req.url))
    }
    return NextResponse.next()
  } catch (error) {
    Sentry.captureException(error)
    return NextResponse.redirect(new URL('/sign-in', req.url))
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
