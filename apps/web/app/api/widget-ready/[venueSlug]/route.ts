import { appRouter, createTRPCContext } from '@pathfinder/api'
import { isEmbedPreviewEnabled } from '@pathfinder/config/feature-flags'

import { classifyPublicVenueLookupError } from '../../../../lib/public-venue-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VENUE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

function widgetReadyHeaders() {
  return {
    'Access-Control-Expose-Headers': 'X-PathFinder-Revision, X-PathFinder-Widget-Ready',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-PathFinder-Revision':
      process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
  } as const
}

function unavailable(status: 404 | 503) {
  return new Response(null, { status, headers: widgetReadyHeaders() })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ venueSlug: string }> },
) {
  if (!isEmbedPreviewEnabled()) {
    return unavailable(404)
  }

  const { venueSlug } = await params
  if (venueSlug.length > 200 || !VENUE_SLUG_PATTERN.test(venueSlug)) {
    return unavailable(404)
  }
  try {
    const ctx = await createTRPCContext({
      // Host-page headers never become tenant or widget authority.
      req: new Request(`https://pathfinder.local/api/widget-ready/${venueSlug}`),
    })
    await appRouter.createCaller(ctx).venue.getBySlug({ slug: venueSlug })
    return new Response(null, {
      status: 204,
      headers: {
        ...widgetReadyHeaders(),
        'X-PathFinder-Widget-Ready': '1',
      },
    })
  } catch (error) {
    const failure = classifyPublicVenueLookupError(error)
    return unavailable(failure === 'not-found' ? 404 : 503)
  }
}
