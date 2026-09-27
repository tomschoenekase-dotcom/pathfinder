'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { QRCodeSVG } from 'qrcode.react'
import { ArrowUpRight, Check, Copy, Download } from 'lucide-react'

import { buildQrEntryUrl } from '../../lib/guest-chat-url'
import {
  PortalSection,
  portalButtonSecondary,
  portalFocus,
  portalTextLink,
} from './PortalPrimitives'

export type HomeGuideState =
  | { kind: 'published'; url: string }
  | { kind: 'paused' }
  | { kind: 'preview' }
  | { kind: 'building' }
  | { kind: 'link-unavailable' }

async function writeClipboard(value: string) {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
  await navigator.clipboard.writeText(value)
}

export function HomeGuideLink({
  venueId,
  venueName,
  guide,
}: {
  venueId: string
  venueName: string
  guide: HomeGuideState
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linkFieldRef = useRef<HTMLInputElement>(null)
  useEffect(() => () => void (resetTimer.current && clearTimeout(resetTimer.current)), [])

  const venueQuery = encodeURIComponent(venueId)
  const qrUrl = guide.kind === 'published' ? buildQrEntryUrl(guide.url) : null

  async function copy(url: string) {
    try {
      await writeClipboard(url)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
      linkFieldRef.current?.select()
    }
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopyState('idle'), 4000)
  }

  if (guide.kind !== 'published') {
    const message =
      guide.kind === 'paused'
        ? {
            body: 'Your visitor guide is paused, so visitors can’t open it right now.',
            action: { href: `/support?venue=${venueQuery}`, label: 'Ask Torchiko about it' },
          }
        : guide.kind === 'preview'
          ? {
              body: 'Your guide is ready for you to preview. Visitors can’t open it yet; your link and QR code appear here once it’s published.',
              action: null,
            }
          : guide.kind === 'link-unavailable'
            ? {
                body: 'We couldn’t load your visitor link just now. Refresh the page, or ask us in Help if it keeps happening.',
                action: { href: `/support?venue=${venueQuery}`, label: 'Open Help' },
              }
            : {
                body: 'Torchiko is still putting your guide together. Your visitor link and QR code will appear here when it’s published.',
                action: null,
              }
    return (
      <PortalSection id="guide-heading" title="Your visitor guide">
        <p className="mt-2 max-w-prose text-sm leading-6 text-tk-ink" role="status">
          {message.body}
        </p>
        {message.action ? (
          <p className="mt-3 text-sm">
            <Link href={message.action.href} className={portalTextLink}>
              {message.action.label}
            </Link>
          </p>
        ) : null}
      </PortalSection>
    )
  }

  return (
    <PortalSection
      id="guide-heading"
      title="Your visitor guide"
      description="Share this link with your visitors."
    >
      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
        <div className="min-w-0 flex-1">
          <label htmlFor="visitor-link" className="sr-only">
            Visitor guide link for {venueName}
          </label>
          <div className="flex min-w-0 flex-col gap-2 min-[480px]:flex-row">
            <input
              id="visitor-link"
              ref={linkFieldRef}
              readOnly
              value={guide.url}
              title={guide.url}
              onFocus={(event) => event.currentTarget.select()}
              className={`min-h-11 min-w-0 flex-1 truncate rounded-lg border border-tk-rule-strong bg-white px-3 text-sm text-tk-ink ${portalFocus}`}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copy(guide.url)}
                className={`${portalButtonSecondary} flex-1 min-[480px]:flex-none`}
              >
                {copyState === 'copied' ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </button>
              <a
                href={guide.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`${portalButtonSecondary} flex-1 min-[480px]:flex-none`}
              >
                Open
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </div>
          </div>
          <p
            aria-live="polite"
            className={copyState === 'failed' ? 'mt-2 text-sm text-tk-ink' : 'sr-only'}
          >
            {copyState === 'copied'
              ? 'Link copied.'
              : copyState === 'failed'
                ? 'Copying isn’t available here. The link is selected so you can copy it yourself.'
                : null}
          </p>
          <p className="mt-3 text-sm leading-6 text-tk-soft">
            Print the QR code for your entrance or front desk, or put the link on your website.{' '}
            <Link
              href={`/venues/${venueQuery}/qr-kit`}
              className={`${portalTextLink} inline-flex items-center gap-1`}
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download or print
            </Link>
          </p>
        </div>
        {qrUrl ? (
          <figure className="flex shrink-0 items-center gap-4 sm:flex-col sm:gap-1.5">
            <div className="rounded-lg border border-tk-rule bg-white p-2">
              <QRCodeSVG
                value={qrUrl}
                size={104}
                level="M"
                marginSize={0}
                role="img"
                aria-label={`QR code that opens the ${venueName} visitor guide`}
                data-qr-value={qrUrl}
              />
            </div>
            <figcaption className="text-sm leading-5 text-tk-soft">
              Scan to open the guide
            </figcaption>
          </figure>
        ) : null}
      </div>
    </PortalSection>
  )
}
