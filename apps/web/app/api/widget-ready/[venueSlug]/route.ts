import { resolveCachedVenueDistribution } from '@pathfinder/db'
import { getChatPalette, isHexColor } from '@pathfinder/ui/theme'
import { resolveReleaseRevision } from '@pathfinder/config/release-identity'

import { getPublicVenue } from '../../../../lib/public-venue'

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
    'X-PathFinder-Revision': resolveReleaseRevision(process.env),
  } as const
}

function unavailable(status: 404 | 503) {
  return new Response(null, { status, headers: widgetReadyHeaders() })
}

function buildLauncherLabel(name: string): string {
  const label = `Ask ${name.trim()}`
  const characters = Array.from(label)
  if (characters.length <= 40) return label || 'Ask Torchiko'

  const prefix = characters.slice(0, 39).join('')
  const wordBoundary = prefix.lastIndexOf(' ')
  return wordBoundary > 4 ? `${prefix.slice(0, wordBoundary).trimEnd()}…` : 'Ask Torchiko…'
}

function requestingOriginIsAdmitted(origin: string | null, admittedOrigins: readonly string[]) {
  if (!origin || admittedOrigins.length === 0) return true
  try {
    const parsed = new URL(origin)
    return parsed.origin === origin && admittedOrigins.includes(parsed.origin)
  } catch {
    return false
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ venueSlug: string }> },
) {
  const { venueSlug } = await params
  if (venueSlug.length > 200 || !VENUE_SLUG_PATTERN.test(venueSlug)) {
    return unavailable(404)
  }
  try {
    const distribution = await resolveCachedVenueDistribution({ venueSlug })
    if (!distribution) return unavailable(404)
    if (!distribution.venueActive) return unavailable(404)
    if (!distribution.website.framed) return unavailable(404)
    if (!requestingOriginIsAdmitted(request.headers.get('origin'), distribution.website.origins)) {
      return unavailable(404)
    }

    if (new URL(request.url).searchParams.get('v') !== '2') {
      return new Response(null, {
        status: 204,
        headers: { ...widgetReadyHeaders(), 'X-PathFinder-Widget-Ready': '1' },
      })
    }

    const venue = await getPublicVenue(venueSlug)
    const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
    const guideName = venue.aiGuideName?.trim() || venue.name
    const safeLabel = buildLauncherLabel(guideName)
    return Response.json(
      {
        v: 2,
        label: safeLabel,
        accent: isHexColor(venue.chatAccentColor) ? venue.chatAccentColor : palette.accent,
        theme: palette.isDark ? 'dark' : 'light',
        background: isHexColor(palette.bg) ? palette.bg : '#F2F5F9',
      },
      { status: 200, headers: widgetReadyHeaders() },
    )
  } catch {
    return unavailable(503)
  }
}
