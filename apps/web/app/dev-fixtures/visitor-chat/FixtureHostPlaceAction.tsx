'use client'

import { useMemo, type ReactNode } from 'react'

import { createHostPlaceAction, HostPlaceActionProvider } from '../../../components/HostPlaceAction'
import { postPlaceActionToNativeHost } from '../../../lib/use-host-bridge'

/** Development-only app-host opt-in, using the same native message path as `/app/<slug>`. */
export function FixtureHostPlaceAction({
  label,
  children,
}: {
  label: string | undefined
  children: ReactNode
}) {
  const action = useMemo(
    () =>
      createHostPlaceAction({
        presentation: 'webview',
        label,
        secondLayer: false,
        post: postPlaceActionToNativeHost,
        track: () => undefined,
      }),
    [label],
  )
  return <HostPlaceActionProvider value={action}>{children}</HostPlaceActionProvider>
}
