import { buildVenueAccessArtifacts } from '@pathfinder/contracts/venue-access-artifacts'
import {
  PartnerGuideProjection,
  type PartnerGuideProjection as PartnerGuideProjectionType,
} from '@pathfinder/contracts/partner-read-api'
import type { VenueDistributionReadback } from '@pathfinder/db'

/**
 * Projects only the app WebView door after its canonical distribution readback is effective.
 * The caller must obtain the distribution readback from resolveVenueDistribution for this venue.
 */
export function projectPartnerGuide(input: {
  distribution: Pick<VenueDistributionReadback, 'app' | 'venueId'>
  venueSlug: string
  webOrigin: string | null | undefined
  appBackground: string | null
}): PartnerGuideProjectionType | null {
  if (!input.distribution.app.effective) return null

  const artifacts = buildVenueAccessArtifacts(input.webOrigin, input.venueSlug, {
    ...(input.appBackground !== null ? { appBackground: input.appBackground } : {}),
  })
  if (!artifacts) return null

  return PartnerGuideProjection.parse({
    venueId: input.distribution.venueId,
    urls: { app: artifacts.appUrl, compactApp: artifacts.compactAppUrl },
    theme: { appBackground: artifacts.appBackground },
  })
}
