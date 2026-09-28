'use client'

import { useEffect, useState } from 'react'

import { VenueChatFixture } from '../../components/VenueChatFixture'
import {
  APPEARANCE_PREVIEW_READY,
  parseAppearancePreviewMessage,
  type AppearancePreviewMedia,
  type AppearancePreviewState,
} from './preview-params'

function useMediaUrl(media: AppearancePreviewMedia): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined)
  const blob = media?.kind === 'blob' ? media.blob : null
  useEffect(() => {
    if (!blob) {
      setBlobUrl(undefined)
      return
    }
    const url = URL.createObjectURL(blob)
    setBlobUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [blob])
  if (!media) return undefined
  return media.kind === 'path' ? media.path : blobUrl
}

/**
 * The actual visitor renderer with a fixed placeholder conversation. When the client portal
 * frames this page, it sends the current unsaved draft here; nothing is sent anywhere else.
 */
export function AppearancePreviewClient({
  initial,
  parentOrigin,
  inertFrame = false,
}: {
  initial: AppearancePreviewState
  parentOrigin: string | null
  /** The framed preview is already inert, so it can show the composer exactly as visitors do. */
  inertFrame?: boolean
}) {
  const [state, setState] = useState(initial)

  useEffect(() => {
    if (!parentOrigin || window.parent === window) return
    function receive(event: MessageEvent) {
      if (event.origin !== parentOrigin || event.source !== window.parent) return
      const next = parseAppearancePreviewMessage(event.data)
      if (next) setState(next)
    }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: APPEARANCE_PREVIEW_READY, version: 1 }, parentOrigin)
    return () => window.removeEventListener('message', receive)
  }, [parentOrigin])

  const background = useMediaUrl(state.background)
  const logo = useMediaUrl(state.logo)

  return (
    <VenueChatFixture
      mode="classic"
      state="idle"
      conversation="placeholder"
      asset="ok"
      motion="reduced"
      voice="none"
      network="online"
      route="none"
      branding="none"
      readOnly={!inertFrame}
      theme={state.theme}
      font={state.font}
      accent={state.accent}
      {...(state.appearance ? { appearance: state.appearance } : {})}
      {...(background ? { backgroundUrl: background } : {})}
      {...(logo ? { logoUrl: logo } : {})}
      {...(state.venueName ? { venueName: state.venueName } : {})}
    />
  )
}
