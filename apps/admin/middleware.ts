import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

export default clerkMiddleware(async (auth, req) => {
  if (req.nextUrl.pathname.startsWith('/sign-in')) {
    return NextResponse.next()
  }

  const authState = await auth()
  const platformRole =
    authState.sessionClaims?.publicMetadata &&
    typeof authState.sessionClaims.publicMetadata === 'object' &&
    'platform_role' in authState.sessionClaims.publicMetadata
      ? authState.sessionClaims.publicMetadata.platform_role
      : undefined

  if (!authState.userId) {
    return authState.redirectToSignIn()
  }

  if (platformRole !== 'PLATFORM_ADMIN') {
    return new Response('Forbidden', { status: 403 })
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
