'use client'

import { useEffect, useRef, useState } from 'react'

import {
  encodeChatAppearanceParam,
  type ChatAppearance,
} from '@pathfinder/contracts/chat-appearance'

export type PreviewMedia = { kind: 'path'; path: string } | { kind: 'blob'; blob: Blob } | null

const PREVIEW_MESSAGE = 'torchiko:appearance-preview'
const PREVIEW_READY = 'torchiko:appearance-preview-ready'
const READY_TIMEOUT_MS = 12_000

function initialSrc(
  origin: string,
  input: {
    venueName: string
    theme: string | null
    font: string | null
    accent: string | null
    appearance: ChatAppearance
    logo: PreviewMedia
    background: PreviewMedia
  },
) {
  const url = new URL('/appearance-preview', origin)
  url.searchParams.set('embed', '1')
  url.searchParams.set('name', input.venueName)
  if (input.theme) url.searchParams.set('theme', input.theme)
  if (input.font) url.searchParams.set('font', input.font)
  if (input.accent) url.searchParams.set('accent', input.accent)
  url.searchParams.set('appearance', encodeChatAppearanceParam(input.appearance))
  if (input.logo?.kind === 'path') url.searchParams.set('logo', input.logo.path)
  if (input.background?.kind === 'path') url.searchParams.set('background', input.background.path)
  return url.toString()
}

/**
 * Frames the real visitor renderer (the visitor app's appearance-preview route) and streams the
 * unsaved draft into it. The sample conversation is fixed placeholder text; no message, model
 * call or visitor data is involved.
 */
export function LiveVisitorPreview({
  origin,
  venueName,
  theme,
  font,
  accent,
  appearance,
  logo,
  background,
  caption,
}: {
  origin: string | null
  venueName: string
  theme: string | null
  font: string | null
  accent: string | null
  appearance: ChatAppearance
  logo: PreviewMedia
  background: PreviewMedia
  caption: string
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [src] = useState(() =>
    origin
      ? initialSrc(origin, { venueName, theme, font, accent, appearance, logo, background })
      : null,
  )

  useEffect(() => {
    if (!origin) return
    function receive(event: MessageEvent) {
      if (event.origin !== origin || event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { type?: unknown } | null
      if (data?.type === PREVIEW_READY) setStatus('ready')
    }
    window.addEventListener('message', receive)
    const timer = setTimeout(
      () => setStatus((current) => (current === 'ready' ? current : 'unavailable')),
      READY_TIMEOUT_MS,
    )
    return () => {
      window.removeEventListener('message', receive)
      clearTimeout(timer)
    }
  }, [origin])

  useEffect(() => {
    if (!origin || status !== 'ready') return
    frameRef.current?.contentWindow?.postMessage(
      {
        type: PREVIEW_MESSAGE,
        version: 1,
        venueName,
        theme,
        font,
        accent,
        appearance,
        logo,
        background,
      },
      origin,
    )
  }, [origin, status, venueName, theme, font, accent, appearance, logo, background])

  return (
    <figure className="mx-auto w-full max-w-[380px]">
      <div className="relative h-[min(760px,calc(100dvh-13rem))] min-h-[520px] overflow-hidden rounded-[1.9rem] border-[7px] border-tk-ink bg-tk-ink shadow-[0_22px_44px_-30px_rgba(16,47,80,0.55)] lg:h-[min(740px,calc(100dvh-11rem))]">
        {src ? (
          <iframe
            ref={frameRef}
            src={src}
            title={`Preview of the ${venueName} visitor guide`}
            tabIndex={-1}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            className={`h-full w-full rounded-[1.4rem] bg-white transition-opacity duration-300 motion-reduce:transition-none ${
              status === 'ready' ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ) : null}
        {status !== 'ready' || !src ? (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center rounded-[1.4rem] bg-tk-card p-8 text-center text-sm leading-6 text-tk-soft"
          >
            {!src
              ? 'The live preview isn’t available in this environment yet. Your changes still save normally.'
              : status === 'unavailable'
                ? 'The preview couldn’t load. Your changes still save normally—refresh to try again.'
                : 'Loading the preview…'}
          </div>
        ) : null}
      </div>
      <figcaption className="mt-3 text-center text-[0.8rem] leading-5 text-tk-soft">
        {caption}
      </figcaption>
    </figure>
  )
}
