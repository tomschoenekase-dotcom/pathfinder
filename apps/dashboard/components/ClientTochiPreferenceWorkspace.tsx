'use client'

import React, { useEffect, useState } from 'react'

import { BoundedClientRequestError, runBoundedClientRequest } from '../lib/bounded-client-request'
import { useTRPCClient } from '../lib/trpc'
import { ClientTochiPreference } from './ClientTochiPreference'

type PreferenceBootstrap = {
  available: boolean
  selectedVenueId: string | null
  preference: { enabled: boolean; minimized: boolean; revision: number }
}

const CLIENT_ASSISTANT_READ_TIMEOUT_MS = 15_000

export function ClientTochiPreferenceWorkspace() {
  const client = useTRPCClient()
  const [state, setState] = useState<PreferenceBootstrap | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    if (!client.clientAssistant) return () => undefined
    setLoadFailed(false)
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: CLIENT_ASSISTANT_READ_TIMEOUT_MS,
      request: (signal) => client.clientAssistant.bootstrap.query({}, { signal }),
    })
      .then((result) => {
        if (!controller.signal.aborted) setState(result)
      })
      .catch((error: unknown) => {
        if (error instanceof BoundedClientRequestError && error.code === 'CANCELLED') return
        if (!controller.signal.aborted) setLoadFailed(true)
      })
    return () => {
      controller.abort()
    }
  }, [client])

  if (loadFailed) {
    return (
      <p className="text-sm text-pf-deep/75" role="alert">
        Assistance preference could not be loaded. Your existing setting was not changed. Reload
        this page to try again.
      </p>
    )
  }

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
