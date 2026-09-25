import { appRouter, createTRPCContext } from '@pathfinder/api'
import { gmailOAuthRuntime } from './gmail-oauth-runtime'

// Server-side tRPC caller for admin pages. resolveSession() reads the Clerk
// session from the request context, so the fabricated Request URL is only a
// placeholder — the real identity (including platform_role) comes from Clerk.
export async function createAdminCaller(): Promise<ReturnType<typeof appRouter.createCaller>> {
  const runtime = gmailOAuthRuntime()
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/admin'),
    gmailDraftReader: runtime ? (input) => runtime.readDraft(input) : null,
  })

  return appRouter.createCaller(ctx)
}
