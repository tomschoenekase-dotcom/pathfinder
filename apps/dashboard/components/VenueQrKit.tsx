'use client'

import { useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'

import { buildGuideItemEntryUrl, buildQrEntryUrl } from '../lib/guest-chat-url'
import { buildQrSvgFilename, downloadQrSvg, downloadQrSvgBytes } from '../lib/qr-export'
import { CopyUrlButton } from './CopyUrlButton'

type GuideItem = {
  id: string
  name: string
  updatedAt: string
}

type VenueQrKitProps = {
  audience?: 'admin' | 'client'
  venueName: string
  guestChatUrl: string
  generatedAt: string
  guideItems: GuideItem[]
  venueAsset?: VenueLaunchAsset | null
  includeGuideItemCodes?: boolean
}

function QrCard({
  label,
  url,
  revision,
  venueAsset,
  showRevision = true,
}: {
  label: string
  url: string
  revision: string
  venueAsset?: VenueLaunchAsset | null
  showRevision?: boolean
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  function handleDownload() {
    setExportError(null)
    try {
      if (venueAsset) downloadQrSvgBytes(venueAsset.contentBase64, venueAsset.filename)
      else downloadQrSvg(svgRef.current, buildQrSvgFilename(label))
    } catch {
      setExportError('This QR code could not be downloaded. Try printing this page instead.')
    }
  }

  return (
    <article className="break-inside-avoid rounded-3xl border border-pf-light bg-white p-6 shadow-sm print:shadow-none">
      <QRCodeSVG
        ref={svgRef}
        value={url}
        size={208}
        level="M"
        marginSize={4}
        title={`QR code for ${label}`}
        className="mx-auto h-auto w-full max-w-52"
      />
      <h2 className="mt-5 text-center text-xl font-semibold text-pf-deep">{label}</h2>
      <p className="mt-2 break-all text-center font-mono text-[10px] leading-4 text-pf-deep/80">
        {url}
      </p>
      {showRevision ? (
        <p className="mt-2 text-center text-xs text-pf-deep/80">Content revision: {revision}</p>
      ) : null}
      <p className="mt-3 text-center text-xs leading-5 text-pf-deep/70 print:hidden">
        Save this QR code for signs and handouts. It stays sharp when resized.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2 print:hidden">
        <CopyUrlButton url={url} />
        <button
          type="button"
          onClick={handleDownload}
          aria-label={`Download SVG for ${label}`}
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-deep/25 px-4 text-sm font-medium text-pf-deep hover:border-pf-primary hover:text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
        >
          Download SVG
        </button>
      </div>
      {exportError ? (
        <p className="mt-3 text-center text-sm text-pf-deep print:hidden" role="alert">
          {exportError}
        </p>
      ) : null}
    </article>
  )
}

export function VenueQrKit({
  audience = 'admin',
  venueName,
  guestChatUrl,
  generatedAt,
  guideItems,
  venueAsset,
  includeGuideItemCodes = false,
}: VenueQrKitProps) {
  const venueQrUrl = venueAsset?.publicUrl ?? buildQrEntryUrl(guestChatUrl)
  const itemEntries = includeGuideItemCodes
    ? guideItems.flatMap((item) => {
        const url = buildGuideItemEntryUrl(guestChatUrl, item)
        return url ? [{ ...item, url }] : []
      })
    : []
  const isClient = audience === 'client'

  return (
    <section aria-labelledby="qr-kit-title">
      <div className="flex flex-col gap-4 print:hidden sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pf-primary">
            {isClient ? 'Visitor access' : 'Internal print tool'}
          </p>
          <h1 id="qr-kit-title" className="mt-2 text-4xl font-semibold text-pf-deep">
            {isClient ? `${venueName} QR code` : `${venueName} QR kit`}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/80">
            {isClient
              ? 'Use this one code on signs, handouts, and anywhere visitors need the guide.'
              : `Scan-test ${itemEntries.length > 0 ? 'every code' : 'the code'} before printing. Creating this sheet does not approve public launch.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-deep px-5 text-sm font-medium text-white hover:bg-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
        >
          {isClient ? 'Print QR code' : 'Print QR sheets'}
        </button>
      </div>

      <p className="my-6 text-xs text-pf-deep/80 print:mt-0">
        {isClient
          ? 'Scan the code once before displaying it.'
          : `Generated ${generatedAt}. URLs contain no secret and remain subject to venue availability, rate limits, and incident controls.`}
      </p>

      <div
        className={
          itemEntries.length > 0
            ? 'grid gap-6 md:grid-cols-2 xl:grid-cols-3 print:grid-cols-2'
            : 'mx-auto max-w-md'
        }
      >
        {venueQrUrl ? (
          <QrCard
            label={`${venueName} visitor guide`}
            url={venueQrUrl}
            revision={
              venueAsset
                ? `${venueAsset.release.kind.toLowerCase()} ${venueAsset.release.revisionSha256.slice(0, 12)}`
                : 'venue link'
            }
            venueAsset={venueAsset ?? null}
            showRevision={!isClient}
          />
        ) : null}
        {itemEntries.map((item) => (
          <QrCard key={item.id} label={item.name} url={item.url} revision={item.updatedAt} />
        ))}
      </div>
    </section>
  )
}
