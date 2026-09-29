'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { VenueChatPresentation } from '../components/venue-chat-types'
import {
  buildPlaceActionMessage,
  normalizeBridgeOrigins,
  parseHostToGuideMessage,
  type HostBridgeMessage,
  type HostPrefill,
} from './host-bridge'

function nativePost(message: HostBridgeMessage) {
  const nativeWindow = window as Window & {
    ReactNativeWebView?: { postMessage: (message: string) => void }
    webkit?: { messageHandlers?: { torchiko?: { postMessage: (message: string) => void } } }
  }
  const serialized = JSON.stringify(message)
  if (nativeWindow.ReactNativeWebView?.postMessage) {
    nativeWindow.ReactNativeWebView.postMessage(serialized)
    return true
  }
  if (nativeWindow.webkit?.messageHandlers?.torchiko?.postMessage) {
    nativeWindow.webkit.messageHandlers.torchiko.postMessage(serialized)
    return true
  }
  return false
}

/**
 * App doors only: after a visitor taps a place card's host button, hand the public place ID
 * and name to the native screen. Returns false when no native message channel exists.
 */
export function postPlaceActionToNativeHost(place: { id: string; name: string }): boolean {
  const message = buildPlaceActionMessage(place)
  return message ? nativePost(message) : false
}

export function useHostBridge({
  presentation,
  allowedOrigins = [],
  onPlace,
}: {
  presentation: VenueChatPresentation
  allowedOrigins?: readonly string[] | undefined
  onPlace?: ((placeId: string) => void) | undefined
}) {
  const originKey = allowedOrigins.join('\u0000')
  // The server supplies this small allowlist. Keep the hook stable across parent rerenders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const origins = useMemo(() => normalizeBridgeOrigins(allowedOrigins), [originKey])
  const placeCallback = useRef(onPlace)
  placeCallback.current = onPlace
  const shellRef = useRef<HTMLDivElement>(null)
  const [prefill, setPrefill] = useState<{ sequence: number; ask: string } | null>(null)
  const [hostOpen, setHostOpen] = useState(true)
  const sequence = useRef(0)
  const website = presentation === 'embed' || presentation === 'embed-inline'
  const app = presentation === 'webview'

  const emit = useCallback(
    (
      type: 'ready' | 'open' | 'close-requested' | 'height',
      payload: { height: number } | null = null,
    ) => {
      const message: HostBridgeMessage = { source: 'torchiko', v: 1, type, payload }
      if (website && window.parent !== window) {
        for (const origin of origins) window.parent.postMessage(message, origin)
      } else if (app) {
        nativePost(message)
      }
    },
    [app, origins, website],
  )

  useEffect(() => {
    if (!website || window.parent === window) {
      if (!app) return
      // A native host injects `window.postMessage(envelope, location.origin)` into the guide
      // document itself (injectJavaScript / evaluateJavaScript), so only a same-document
      // prefill is accepted. It fills the composer without sending, as `ask` does.
      const onAppMessage = (event: MessageEvent) => {
        if (event.source !== window || event.origin !== window.location.origin) return
        const message = parseHostToGuideMessage(event.data)
        if (message?.type !== 'prefill') return
        const input = message.payload as HostPrefill
        if (input.ask) setPrefill({ sequence: ++sequence.current, ask: input.ask })
        if (input.place) placeCallback.current?.(input.place)
      }
      window.addEventListener('message', onAppMessage)
      emit('ready')
      emit('open')
      return () => window.removeEventListener('message', onAppMessage)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || !origins.includes(event.origin)) return
      const message = parseHostToGuideMessage(event.data)
      if (!message) return
      if (message.type === 'open') {
        setHostOpen(true)
        emit('open')
      }
      if (message.type === 'close') setHostOpen(false)
      if (message.type === 'prefill') {
        const input = message.payload as HostPrefill
        if (input.ask) setPrefill({ sequence: ++sequence.current, ask: input.ask })
        if (input.place) placeCallback.current?.(input.place)
      }
    }
    window.addEventListener('message', onMessage)
    emit('ready')
    if (presentation === 'embed-inline') emit('open')
    return () => window.removeEventListener('message', onMessage)
  }, [app, emit, origins, presentation, website])

  useEffect(() => {
    if (
      presentation !== 'embed-inline' ||
      !shellRef.current ||
      typeof ResizeObserver === 'undefined'
    )
      return
    let lastHeight = 0
    let lastSentAt = 0
    const observer = new ResizeObserver(() => {
      const height = Math.round(shellRef.current?.getBoundingClientRect().height ?? 0)
      const now = Date.now()
      if (height < 320 || height > 1600 || height === lastHeight || now - lastSentAt < 100) return
      lastHeight = height
      lastSentAt = now
      emit('height', { height })
    })
    observer.observe(shellRef.current)
    return () => observer.disconnect()
  }, [emit, presentation])

  return { shellRef, prefill, hostOpen, requestClose: () => emit('close-requested') }
}
