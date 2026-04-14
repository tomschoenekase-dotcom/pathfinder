import { clerkMiddleware } from '@clerk/nextjs/server'

// clerkMiddleware() is required for auth() to work in server components.
// The web app is guest-facing — no routes are protected.
export default clerkMiddleware()

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
