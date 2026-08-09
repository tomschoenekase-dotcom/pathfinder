'use client'

import { useEffect, useRef } from 'react'

export const WIDGET_READY_MESSAGE_TYPE = 'pathfinder:embed-ready'
export const WIDGET_READY_MESSAGE_VERSION = 1

export function WidgetReadySignal({ venueSlug }: { venueSlug: string }) {
  const sent = useRef(false)

  useEffect(() => {
    if (sent.current || window.parent === window) return
    sent.current = true
    window.parent.postMessage(
      {
        type: WIDGET_READY_MESSAGE_TYPE,
        version: WIDGET_READY_MESSAGE_VERSION,
        venueSlug,
      },
      '*',
    )
  }, [venueSlug])

  return null
}
