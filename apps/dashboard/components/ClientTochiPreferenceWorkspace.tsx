'use client'

import React, { useEffect, useRef, useState } from 'react'

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
  const [state, setState] = useState<{
    owner: unknown
    generation: number
    value: PreferenceBootstrap
  } | null>(null)
  const [loadFailed, setLoadFailed] = useState<unknown | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const clientRef = useRef<unknown>(client)
  clientRef.current = client

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++generationRef.current
    if (!client.clientAssistant) return () => undefined
    setState(null)
    setLoadFailed(null)
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: CLIENT_ASSISTANT_READ_TIMEOUT_MS,
      request: (signal) => client.clientAssistant.bootstrap.query({}, { signal }),
    })
      .then((result) => {
        if (
          !controller.signal.aborted &&
          mountedRef.current &&
          generationRef.current === generation
        ) {
          setState({ owner: client, generation, value: result })
        }
      })
      .catch((error: unknown) => {
        if (error instanceof BoundedClientRequestError && error.code === 'CANCELLED') return
        if (
          !controller.signal.aborted &&
          mountedRef.current &&
          generationRef.current === generation
        ) {
          setLoadFailed(client)
        }
      })
    return () => {
      controller.abort()
    }
  }, [client])

  if (loadFailed === client) {
    return (
      <p className="text-sm text-pf-deep/75" role="alert">
        Assistance preference could not be loaded. Your existing setting was not changed. Reload
        this page to try again.
      </p>
    )
  }

  const visibleState = state?.owner === client ? state.value : null

  if (!visibleState) {
    return <p className="text-sm text-pf-deep/65">Loading assistance preference…</p>
  }

  return (
    <ClientTochiPreference
      key={`${String(visibleState.selectedVenueId)}:${generationRef.current}`}
      initialEnabled={visibleState.preference.enabled}
      available={visibleState.available && visibleState.selectedVenueId !== null}
      onChange={async (enabled) => {
        const capturedGeneration = state?.generation
        const capturedClient = client
        const capturedState = visibleState
        if (!capturedState.selectedVenueId) throw new Error('No venue is available')
        if (
          !mountedRef.current ||
          clientRef.current !== capturedClient ||
          generationRef.current !== capturedGeneration
        ) {
          throw new Error('Preference context changed before the save could be submitted')
        }
        const saved = await capturedClient.clientAssistant.setPreference.mutate({
          venueId: capturedState.selectedVenueId,
          enabled,
          minimized: capturedState.preference.minimized,
          expectedRevision: capturedState.preference.revision,
        })
        if (
          !mountedRef.current ||
          generationRef.current !== capturedGeneration ||
          clientRef.current !== capturedClient
        ) {
          throw new Error('Preference context changed before the save was confirmed')
        }
        setState((current) =>
          current?.owner === capturedClient &&
          current.generation === capturedGeneration &&
          current.value.selectedVenueId === capturedState.selectedVenueId &&
          current.value.preference.revision === capturedState.preference.revision
            ? {
                owner: capturedClient,
                generation: current.generation,
                value: {
                  ...current.value,
                  preference: {
                    enabled: saved.enabled,
                    minimized: saved.minimized,
                    revision: saved.revision,
                  },
                },
              }
            : current,
        )
      }}
    />
  )
}
