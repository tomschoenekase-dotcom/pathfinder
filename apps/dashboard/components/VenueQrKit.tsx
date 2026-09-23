'use client'

import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'

import { buildQrEntryUrl } from '../lib/guest-chat-url'
import { useTRPCClient } from '../lib/trpc'
import { runBoundedClientRequest } from '../lib/bounded-client-request'
import {
  buildQrFilename,
  downloadQrPdf,
  downloadQrAssetBytes,
  downloadQrPng,
  downloadQrSvg,
  downloadQrSvgBytes,
} from '../lib/qr-export'
import { CopyUrlButton } from './CopyUrlButton'

type VenueQrKitProps = {
  audience?: 'admin' | 'client'
  venueName: string
  guestChatUrl: string
  generatedAt: string
  venueAsset?: VenueLaunchAsset | null
}

function QrCard({
  audience,
  label,
  venueName,
  url,
  revision,
  venueAsset,
  showRevision = true,
}: {
  audience: 'admin' | 'client'
  label: string
  venueName: string
  url: string
  revision: string
  venueAsset?: VenueLaunchAsset | null
  showRevision?: boolean
}) {
  const client = useTRPCClient()
  const svgRef = useRef<SVGSVGElement>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const requestAbort = useRef<AbortController | null>(null)

  useEffect(() => () => requestAbort.current?.abort(), [venueAsset?.venueId])

  async function handleDownload(format: 'svg' | 'png' | 'pdf') {
    setExportError(null)
    setExporting(true)
    try {
      if (format === 'svg') {
        if (venueAsset) downloadQrSvgBytes(venueAsset.contentBase64, venueAsset.filename)
        else downloadQrSvg(svgRef.current, buildQrFilename(label, 'svg'))
      } else if (venueAsset) {
        const serverFormat = format.toUpperCase() as 'PNG' | 'PDF'
        const controller = new AbortController()
        requestAbort.current?.abort()
        requestAbort.current = controller
        const asset = await runBoundedClientRequest({
          parentSignal: controller.signal,
          timeoutMs: 30_000,
          request: (signal) =>
            audience === 'admin'
              ? client.admin.getVenueLaunchAsset.query(
                  {
                    tenantId: venueAsset.tenantId,
                    venueId: venueAsset.venueId,
                    format: serverFormat,
                  },
                  { signal },
                )
              : client.portal.getVenueLaunchAsset.query(
                  {
                    venueId: venueAsset.venueId,
                    format: serverFormat,
                  },
                  { signal },
                ),
        })
        if (controller.signal.aborted) return

        if (
          !asset ||
          asset.schema !== 'torchiko.venue-launch-asset/2' ||
          asset.format !== serverFormat ||
          asset.tenantId !== venueAsset.tenantId ||
          asset.venueId !== venueAsset.venueId ||
          asset.publicUrl !== venueAsset.publicUrl ||
          asset.release.kind !== venueAsset.release.kind ||
          asset.release.id !== venueAsset.release.id ||
          asset.release.revisionSha256 !== venueAsset.release.revisionSha256 ||
          asset.mimeType !== (format === 'png' ? 'image/png' : 'application/pdf') ||
          !asset.filename.endsWith(`.${format}`)
        ) {
          throw new Error('The venue QR print asset no longer matches the current release.')
        }

        const binarySize = window.atob(asset.contentBase64).length
        if (binarySize !== asset.sizeBytes) {
          throw new Error('The venue QR print asset bytes are incomplete.')
        }
        downloadQrAssetBytes(asset.contentBase64, asset.mimeType, asset.filename)
      } else if (format === 'png') {
        await downloadQrPng(url, buildQrFilename(label, 'png'))
      } else {
        downloadQrPdf(venueName, url, buildQrFilename(venueName, 'pdf'))
      }
    } catch {
      setExportError(`The ${format.toUpperCase()} QR export could not be downloaded. Try again.`)
    } finally {
      requestAbort.current = null
      setExporting(false)
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
          onClick={() => void handleDownload('svg')}
          aria-label={`Download SVG for ${label}`}
          disabled={exporting}
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-deep/25 px-4 text-sm font-medium text-pf-deep hover:border-pf-primary hover:text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
        >
          Download SVG
        </button>
        <button
          type="button"
          onClick={() => void handleDownload('png')}
          aria-label={`Download PNG for ${label}`}
          disabled={exporting}
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-deep/25 px-4 text-sm font-medium text-pf-deep hover:border-pf-primary hover:text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          Download PNG
        </button>
        <button
          type="button"
          onClick={() => void handleDownload('pdf')}
          aria-label={`Download PDF for ${label}`}
          disabled={exporting}
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-deep/25 px-4 text-sm font-medium text-pf-deep hover:border-pf-primary hover:text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          Download PDF
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
  venueAsset,
}: VenueQrKitProps) {
  const venueQrUrl = venueAsset?.publicUrl ?? buildQrEntryUrl(guestChatUrl)
  const isClient = audience === 'client'

  return (
    <section aria-labelledby="qr-kit-title">
      <div className="flex flex-col gap-4 print:hidden sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pf-primary">
            {isClient ? 'Visitor access' : 'Internal print tool'}
          </p>
          <h1 id="qr-kit-title" className="mt-2 text-4xl font-semibold text-pf-deep">
            {venueName} QR code
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/80">
            {isClient
              ? 'Use this one code on signs, handouts, and anywhere visitors need the guide.'
              : 'Scan-test the code before printing. Creating this sheet does not approve public launch.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-deep px-5 text-sm font-medium text-white hover:bg-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
        >
          Print QR code
        </button>
      </div>

      <p className="my-6 text-xs text-pf-deep/80 print:mt-0">
        {isClient
          ? 'Scan the code once before displaying it.'
          : `Generated ${generatedAt}. URLs contain no secret and remain subject to venue availability, rate limits, and incident controls.`}
      </p>

      <div className="mx-auto max-w-md">
        {venueQrUrl ? (
          <QrCard
            audience={audience}
            label={`${venueName} visitor guide`}
            venueName={venueName}
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
      </div>
    </section>
  )
}
