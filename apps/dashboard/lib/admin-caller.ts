import { appRouter, createTRPCContext } from '@pathfinder/api'

// Server-side tRPC caller for admin pages. resolveSession() reads the Clerk
// session from the request context, so the fabricated Request URL is only a
// placeholder — the real identity (including platform_role) comes from Clerk.
export async function createAdminCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/admin'),
  })

  return appRouter.createCaller(ctx)
}
