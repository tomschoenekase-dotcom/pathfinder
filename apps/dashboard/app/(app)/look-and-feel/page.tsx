import { auth } from '@pathfinder/auth/server'
import { redirect } from 'next/navigation'

import { LookAndFeelEditor } from '../../../components/portal/LookAndFeelEditor'
import { BRANDING_REVIEW_SUBJECTS } from '../../../components/portal/branding-review-subjects'
import { buildGuestChatUrl, resolveGuestWebOrigin } from '../../../lib/guest-chat-url'
import { isManagerRole } from '../../../lib/portal-capabilities'
import { createDashboardCaller } from '../../../lib/server-caller'

type LookAndFeelPageProps = {
  searchParams: Promise<{ venue?: string | string[] }>
}

const PUBLISHED_STATES = new Set(['READY', 'LIVE', 'REVISIONS'])

export default async function LookAndFeelPage({ searchParams }: LookAndFeelPageProps) {
  const { orgRole, sessionClaims } = await auth()
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  const canEdit = isManagerRole(orgRole, isPlatformAdmin)
  const caller = await createDashboardCaller('/look-and-feel')
  const [venues, lifecycles] = await Promise.all([
    caller.venue.list(),
    caller.portal.getVenueLifecycles(),
  ])
  if (venues.length === 0) redirect('/onboarding/setup')

  const query = await searchParams
  const requested = Array.isArray(query.venue) ? query.venue[0] : query.venue
  const venue = venues.find((candidate) => candidate.id === requested) ?? venues[0]!
  const lifecycle = lifecycles.find((row) => row.venueId === venue.id)?.lifecycle

  const [approved, supportPage, places] = await Promise.all([
    canEdit
      ? caller.venue
          .listApprovedBrandingAssets({ venueId: venue.id })
          .catch(() => ({ items: [], nextCursor: null }))
      : Promise.resolve({ items: [], nextCursor: null }),
    caller.support.listRequests({ venueId: venue.id }).catch(() => ({ items: [] })),
    canEdit
      ? caller.place
          .list({ venueId: venue.id })
          .then((rows) => rows.map((place) => ({ id: place.id, name: place.name })))
          .catch(() => [])
      : Promise.resolve([]),
  ])

  // A logo or photo sent from this page stays "in review" until Torchiko closes its request.
  const openReview = (subject: string) => {
    const request = supportPage.items.find(
      (item) =>
        item.category === 'BRANDING' &&
        item.subject === subject &&
        item.status !== 'COMPLETED' &&
        item.status !== 'CANCELLED',
    )
    return request
      ? {
          href: `/support?venue=${encodeURIComponent(venue.id)}&request=${encodeURIComponent(request.id)}`,
        }
      : null
  }

  // The live preview frames the data-free sample of the real visitor renderer.
  const allowLocalGuide = process.env.NODE_ENV === 'development'
  const previewUrl = buildGuestChatUrl(
    resolveGuestWebOrigin(process.env.NEXT_PUBLIC_WEB_URL, process.env.RAILWAY_ENVIRONMENT),
    'appearance-preview',
    { allowLoopbackHttp: allowLocalGuide },
  )
  const mediaOrigin = previewUrl ? new URL(previewUrl).origin : null
  const previewAllowed =
    process.env.RAILWAY_ENVIRONMENT === 'production' ||
    process.env.RAILWAY_ENVIRONMENT === 'staging' ||
    allowLocalGuide
  const previewOrigin = previewAllowed && previewUrl ? new URL(previewUrl).origin : null

  return (
    <LookAndFeelEditor
      key={venue.id}
      venues={venues.map((candidate) => ({ id: candidate.id, name: candidate.name }))}
      venue={{
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        updatedAt: venue.updatedAt.toISOString(),
        chatTheme: venue.chatTheme,
        chatAccentColor: venue.chatAccentColor,
        chatFont: venue.chatFont,
        chatAppearance: venue.chatAppearance,
        chatLogoUrl: venue.chatLogoUrl,
        chatBannerUrl: venue.chatBannerUrl,
        chatLogoDerivativeId: venue.chatLogoDerivativeId,
        chatBannerDerivativeId: venue.chatBannerDerivativeId,
      }}
      canEdit={canEdit}
      visibleToVisitors={Boolean(lifecycle && PUBLISHED_STATES.has(lifecycle.state))}
      approvedAssets={approved.items.map((asset) => ({
        derivativeId: asset.derivativeId,
        assetId: asset.assetId,
        altText: asset.altText,
        deliveryPath: asset.deliveryPath,
        sourceObjectGeneration: asset.sourceObjectGeneration,
        sha256: asset.sha256,
        approvedReviewSequence: asset.approvedReviewSequence,
      }))}
      pendingReviews={{
        logo: openReview(BRANDING_REVIEW_SUBJECTS.logo),
        background: openReview(BRANDING_REVIEW_SUBJECTS.background),
      }}
      previewOrigin={previewOrigin}
      mediaOrigin={mediaOrigin}
      places={places}
    />
  )
}
