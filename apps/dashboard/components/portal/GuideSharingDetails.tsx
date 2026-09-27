import Link from 'next/link'

import { CopyAccessValueButton } from '../CopyAccessValueButton'
import { SecondLayerSettings } from '../SecondLayerSettings'
import { PortalSection, portalTextLink } from './PortalPrimitives'

export type GuideDistributionReadback = {
  website: {
    effective: boolean
    reason: string | null
    framed: boolean
    origins: readonly string[]
  }
  app: { effective: boolean; reason: string | null }
  appUrl: string | null
  appBackground: string | null
}

function surfaceStatus(effective: boolean, reason: string | null) {
  if (effective) return 'Switched on'
  if (reason === 'VENUE_INACTIVE') return 'Available once your guide is published'
  if (reason === 'NO_ORIGINS') return 'Torchiko needs your website address first'
  return 'Not switched on for your venue yet'
}

/** Secondary sharing places that used to crowd Home: website, app and the staff link. */
export function GuideSharingDetails({
  venueId,
  distribution,
  secondLayer,
}: {
  venueId: string
  distribution: GuideDistributionReadback | null
  secondLayer: { enabled: boolean; label: string; url: string | null; updatedAt: string } | null
}) {
  if (!distribution && !secondLayer?.enabled) return null
  const venueQuery = encodeURIComponent(venueId)
  return (
    <div className="mx-auto mt-10 max-w-3xl space-y-5 print:hidden">
      {distribution ? (
        <PortalSection
          id="sharing-elsewhere-heading"
          title="On your website or app"
          description="Your guide can also open from your own website or app."
        >
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-semibold">Website</dt>
              <dd className="mt-1 leading-6 text-tk-soft">
                {distribution.website.effective && distribution.website.framed
                  ? `Switched on for ${distribution.website.origins.join(', ')}`
                  : distribution.website.effective
                    ? surfaceStatus(false, 'NO_ORIGINS')
                    : surfaceStatus(false, distribution.website.reason)}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">App</dt>
              <dd className="mt-1 leading-6 text-tk-soft">
                {surfaceStatus(distribution.app.effective, distribution.app.reason)}
                {distribution.app.effective &&
                (distribution.appUrl || distribution.appBackground) ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {distribution.appUrl ? (
                      <CopyAccessValueButton label="app URL" value={distribution.appUrl} />
                    ) : null}
                    {distribution.appBackground ? (
                      <CopyAccessValueButton
                        label="app background color"
                        value={distribution.appBackground}
                      />
                    ) : null}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm leading-6 text-tk-soft">
            Want either one switched on?{' '}
            <Link href={`/support?venue=${venueQuery}`} className={portalTextLink}>
              Ask us in Help
            </Link>
            .
          </p>
        </PortalSection>
      ) : null}
      {secondLayer?.enabled ? (
        <SecondLayerSettings
          venueId={venueId}
          enabled={secondLayer.enabled}
          initialLabel={secondLayer.label}
          initialUrl={secondLayer.url}
          initialUpdatedAt={secondLayer.updatedAt}
        />
      ) : null}
    </div>
  )
}
