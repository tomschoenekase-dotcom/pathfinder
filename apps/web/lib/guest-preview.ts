import { appRouter, createTRPCContext } from '@pathfinder/api'

/**
 * Resolves a private preview through the server-side caller. Returns null for every refusal so the
 * page cannot distinguish (or leak) why a link was rejected; only unexpected failures throw.
 */
export async function getGuestPreview(venueSlug: string, token: string) {
  const ctx = await createTRPCContext({
    req: new Request('https://pathfinder.local/guest-preview'),
  })
  try {
    return await appRouter.createCaller(ctx).guestPreview.getByToken({ slug: venueSlug, token })
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'NOT_FOUND' || code === 'BAD_REQUEST') return null
    throw error
  }
}

export type GuestPreviewData = NonNullable<Awaited<ReturnType<typeof getGuestPreview>>>
