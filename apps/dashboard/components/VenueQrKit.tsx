'use client'

import { QRCodeSVG } from 'qrcode.react'

import { buildGuideItemEntryUrl } from '../lib/guest-chat-url'
import { CopyUrlButton } from './CopyUrlButton'

type GuideItem = {
  id: string
  name: string
  updatedAt: string
}

type VenueQrKitProps = {
  venueName: string
  guestChatUrl: string
  generatedAt: string
  guideItems: GuideItem[]
}

function QrCard({ label, url, revision }: { label: string; url: string; revision: string }) {
  return (
    <article className="break-inside-avoid rounded-3xl border border-pf-light bg-white p-6 shadow-sm print:shadow-none">
      <QRCodeSVG
        value={url}
        size={208}
        level="M"
        marginSize={2}
        title={`QR code for ${label}`}
        className="mx-auto h-auto w-full max-w-52"
      />
      <h2 className="mt-5 text-center text-xl font-semibold text-pf-deep">{label}</h2>
      <p className="mt-2 break-all text-center font-mono text-[10px] leading-4 text-pf-deep/50">
        {url}
      </p>
      <p className="mt-2 text-center text-xs text-pf-deep/40">Content revision: {revision}</p>
      <div className="mt-4 flex justify-center print:hidden">
        <CopyUrlButton url={url} />
      </div>
    </article>
  )
}

export function VenueQrKit({ venueName, guestChatUrl, generatedAt, guideItems }: VenueQrKitProps) {
  const itemEntries = guideItems.flatMap((item) => {
    const url = buildGuideItemEntryUrl(guestChatUrl, item)
    return url ? [{ ...item, url }] : []
  })

  return (
    <section aria-labelledby="qr-kit-title">
      <div className="flex flex-col gap-4 print:hidden sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pf-accent">
            Internal print tool
          </p>
          <h1 id="qr-kit-title" className="mt-2 text-4xl font-semibold text-pf-deep">
            {venueName} QR kit
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/60">
            Scan-test every code before printing. Item codes prefill a question but never send it
            automatically. Creating this sheet does not approve public launch.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white hover:bg-pf-accent"
        >
          Print QR sheets
        </button>
      </div>

      <p className="my-6 text-xs text-pf-deep/40 print:mt-0">
        Generated {generatedAt}. URLs contain no secret and remain subject to venue availability,
        rate limits, and incident controls.
      </p>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3 print:grid-cols-2">
        <QrCard label={`${venueName} guest guide`} url={guestChatUrl} revision="venue link" />
        {itemEntries.map((item) => (
          <QrCard key={item.id} label={item.name} url={item.url} revision={item.updatedAt} />
        ))}
      </div>
    </section>
  )
}
