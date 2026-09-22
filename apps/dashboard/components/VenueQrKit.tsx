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
}

function QrCard({
  label,
  url,
  revision,
  venueAsset,
}: {
  label: string
  url: string
  revision: string
  venueAsset?: VenueLaunchAsset | null
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  function handleDownload() {
    setExportError(null)
    try {
      if (venueAsset) downloadQrSvgBytes(venueAsset.contentBase64, venueAsset.filename)
      else downloadQrSvg(svgRef.current, buildQrSvgFilename(label))
    } catch {
      setExportError('This QR code could not be downloaded. Try Print QR sheets instead.')
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
      <p className="mt-2 text-center text-xs text-pf-deep/80">Content revision: {revision}</p>
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
}: VenueQrKitProps) {
  const venueQrUrl = venueAsset?.publicUrl ?? buildQrEntryUrl(guestChatUrl)
  const itemEntries = guideItems.flatMap((item) => {
    const url = buildGuideItemEntryUrl(guestChatUrl, item)
    return url ? [{ ...item, url }] : []
  })

  return (
    <section aria-labelledby="qr-kit-title">
      <div className="flex flex-col gap-4 print:hidden sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pf-primary">
            {audience === 'client' ? 'Launch materials' : 'Internal print tool'}
          </p>
          <h1 id="qr-kit-title" className="mt-2 text-4xl font-semibold text-pf-deep">
            {venueName} QR kit
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/80">
            Scan-test every code before printing.{' '}
            {itemEntries.length > 0
              ? 'Item codes prefill a question but never send it automatically. '
              : ''}
            {audience === 'admin'
              ? 'Creating this sheet does not approve public launch.'
              : 'Printing this sheet does not change whether the visitor guide is live.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-deep px-5 text-sm font-medium text-white hover:bg-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
        >
          Print QR sheets
        </button>
      </div>

      <p className="my-6 text-xs text-pf-deep/80 print:mt-0">
        {audience === 'client'
          ? `Generated ${generatedAt}. Scan each code before displaying it.`
          : `Generated ${generatedAt}. URLs contain no secret and remain subject to venue availability, rate limits, and incident controls.`}
      </p>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3 print:grid-cols-2">
        {venueQrUrl ? (
          <QrCard
            label={`${venueName} guest guide`}
            url={venueQrUrl}
            revision={
              venueAsset
                ? `${venueAsset.release.kind.toLowerCase()} ${venueAsset.release.revisionSha256.slice(0, 12)}`
                : 'venue link'
            }
            venueAsset={venueAsset ?? null}
          />
        ) : null}
        {itemEntries.map((item) => (
          <QrCard key={item.id} label={item.name} url={item.url} revision={item.updatedAt} />
        ))}
      </div>
    </section>
  )
}
