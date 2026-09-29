'use client'

import { createContext, useContext } from 'react'

import type { VenueChatPresentation } from './venue-chat-types'

export type HostPlaceAction = {
  /** Partner-chosen button text, already bounded by `parsePlaceActionLabel`. */
  label: string
  onAction: (place: { id: string; name: string }) => void
}

// Present only inside an app door whose host opted in with `placeAction`. Place cards read it
// directly so the chat transport and message list stay unaware of the host.
const HostPlaceActionContext = createContext<HostPlaceAction | null>(null)

export const HostPlaceActionProvider = HostPlaceActionContext.Provider

export function useHostPlaceAction(): HostPlaceAction | null {
  return useContext(HostPlaceActionContext)
}

type HostPlace = { id: string; name: string }

/**
 * Only a public app door whose host opted in gets the button. A tap is counted only after a
 * native channel actually received it, so the metric means "handed back to the app".
 */
export function createHostPlaceAction({
  presentation,
  label,
  secondLayer,
  post,
  track,
}: {
  presentation: VenueChatPresentation
  label: string | undefined
  secondLayer: boolean
  post: (place: HostPlace) => boolean
  track: (placeId: string) => void
}): HostPlaceAction | null {
  if (presentation !== 'webview' || !label || secondLayer) return null
  return {
    label,
    onAction: (place) => {
      if (post(place)) track(place.id)
    },
  }
}
