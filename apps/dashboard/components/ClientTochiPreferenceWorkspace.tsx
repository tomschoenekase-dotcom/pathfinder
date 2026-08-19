'use client'

import React, { useEffect, useState } from 'react'

import { useTRPCClient } from '../lib/trpc'
import { ClientTochiPreference } from './ClientTochiPreference'

type PreferenceBootstrap = {
  available: boolean
  selectedVenueId: string | null
  preference: { enabled: boolean; minimized: boolean; revision: number }
}

export function ClientTochiPreferenceWorkspace() {
  const client = useTRPCClient()
  const [state, setState] = useState<PreferenceBootstrap | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!client.clientAssistant) return () => undefined
    void client.clientAssistant.bootstrap
      .query({})
      .then((result) => {
        if (!cancelled) setState(result)
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            available: false,
            selectedVenueId: null,
            preference: { enabled: false, minimized: false, revision: 0 },
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [client])

  if (!state) {
    return <p className="text-sm text-pf-deep/65">Loading assistance preference…</p>
  }

  return (
    <ClientTochiPreference
      initialEnabled={state.preference.enabled}
      available={state.available && state.selectedVenueId !== null}
      onChange={async (enabled) => {
        if (!state.selectedVenueId) throw new Error('No venue is available')
        const saved = await client.clientAssistant.setPreference.mutate({
          venueId: state.selectedVenueId,
          enabled,
          minimized: state.preference.minimized,
          expectedRevision: state.preference.revision,
        })
        setState((current) =>
          current
            ? {
                ...current,
                preference: {
                  enabled: saved.enabled,
                  minimized: saved.minimized,
                  revision: saved.revision,
                },
              }
            : current,
        )
      }}
    />
  )
}
