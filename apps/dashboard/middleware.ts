import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

const AUTH_ROUTES = ['/sign-in', '/sign-up']
// /api/webhooks/clerk must remain here — Clerk sends webhook POST requests
// without a session cookie, so auth() would redirect them with a 307 and break
// automatic tenant creation on org signup.
const PUBLIC_ROUTES = ['/api/webhooks/clerk']

export default clerkMiddleware(async (auth, req) => {
  try {
    const { pathname } = req.nextUrl

    if (AUTH_ROUTES.some((route) => pathname.startsWith(route))) {
      return NextResponse.next()
    }

    if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
      return NextResponse.next()
    }

    const authState = await auth()

    if (!authState.userId) {
      return authState.redirectToSignIn()
    }

    if (!authState.orgId && pathname !== '/onboarding') {
      const onboardingUrl = new URL('/onboarding', req.url)
      return NextResponse.redirect(onboardingUrl)
    }

    return NextResponse.next()
  } catch (err) {
    console.error('[middleware error]', err)
    return NextResponse.next()
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
