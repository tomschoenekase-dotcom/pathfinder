import { TRPCError } from '@trpc/server'
import { appRouter, createTRPCContext } from '@pathfinder/api'
import { notFound, redirect } from 'next/navigation'

type VenueLandingPageProps = {
  params: Promise<{
    venueSlug: string
  }>
}

async function loadVenue(slug: string) {
  const ctx = await createTRPCContext({
    req: new Request(`https://pathfinder.local/${slug}`),
  })

  return appRouter.createCaller(ctx).venue.getBySlug({ slug })
}

export default async function VenueLandingPage({ params }: VenueLandingPageProps) {
  const { venueSlug } = await params

  try {
    await loadVenue(venueSlug)
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      notFound()
    }

    throw error
  }

  redirect(`/${venueSlug}/chat`)
}
