'use client'

import React, { useEffect, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

import { browserUuid } from '../lib/browser-uuid'
import { BoundedClientRequestError, runBoundedClientRequest } from '../lib/bounded-client-request'
import { useTRPCClient } from '../lib/trpc'
import {
  ClientTochiPanel,
  type ClientTochiHandoffPreview,
  type ClientTochiMessage,
  type ClientTochiReply,
} from './ClientTochiPanel'

type BootstrapState = {
  available: boolean
  venues: Array<{ id: string; name: string }>
  selectedVenueId: string | null
  preference: { enabled: boolean; minimized: boolean; revision: number }
  history: Array<{
    id: string
    userMessage: string
    assistantMessage: string | null
    status: string
    action?:
      | { type: 'navigate'; href: string; label: string }
      | {
          type: 'preview-support-handoff'
          category: ClientTochiHandoffPreview['category']
          summary: string
          requestedOutcome: string
          relevantFeature?: string
        }
  }>
}

const CLIENT_ASSISTANT_READ_TIMEOUT_MS = 15_000

function venueIdFromRoute(pathname: string): string | null {
  const routeVenueId = /^\/venues\/([^/]+)(?:\/|$)/u.exec(pathname)?.[1]
  if (!routeVenueId) return null
  try {
    return decodeURIComponent(routeVenueId)
  } catch {
    return null
  }
}

function mapHistory(history: BootstrapState['history']): ClientTochiMessage[] {
  return history.flatMap((turn) => {
    const messages: ClientTochiMessage[] = [
      { id: `${turn.id}-user`, role: 'user', body: turn.userMessage },
    ]
    if (turn.assistantMessage) {
      const action = turn.action
        ? turn.action.type === 'navigate'
          ? turn.action
          : {
              type: 'preview-support-handoff' as const,
              preview: {
                previewId: turn.id,
                category: turn.action.category,
                summary: turn.action.summary,
                requestedOutcome: turn.action.requestedOutcome,
                ...(turn.action.relevantFeature
                  ? { relevantFeature: turn.action.relevantFeature }
                  : {}),
              },
            }
        : undefined
      messages.push({
        id: turn.id,
        role: 'assistant',
        body: turn.assistantMessage,
        ...(action ? { action } : {}),
      })
    }
    return messages
  })
}

function mapReply(reply: {
  id: string
  answer: string
  action?:
    | { type: 'navigate'; href: string; label: string }
    | {
        type: 'preview-support-handoff'
        category: ClientTochiHandoffPreview['category']
        summary: string
        requestedOutcome: string
        relevantFeature?: string
      }
}): ClientTochiReply {
  if (!reply.action) return { id: reply.id, answer: reply.answer }
  if (reply.action.type === 'navigate') {
    return { id: reply.id, answer: reply.answer, action: reply.action }
  }
  return {
    id: reply.id,
    answer: reply.answer,
    action: {
      type: 'preview-support-handoff',
      preview: {
        previewId: reply.id,
        category: reply.action.category,
        summary: reply.action.summary,
        requestedOutcome: reply.action.requestedOutcome,
        ...(reply.action.relevantFeature ? { relevantFeature: reply.action.relevantFeature } : {}),
      },
    },
  }
}

/**
 * Authenticated adapter around the visual panel. It deliberately consumes only
 * the bounded clientAssistant API; public visitor chat and internal agent/MCP
 * infrastructure are not reachable from this surface.
 */
export function ClientTochiWorkspace() {
  const client = useTRPCClient()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const venueRequestRef = useRef<AbortController | null>(null)
  const venueRequestGenerationRef = useRef(0)
  const workspaceGenerationRef = useRef(0)

  const routeVenueId = venueIdFromRoute(pathname)
  const requestedVenueId = routeVenueId ?? searchParams.get('venue')
  const requestedVenueRef = useRef(requestedVenueId)
  const requestedClientRef = useRef(client)
  const bootstrapRequestChanged =
    requestedVenueRef.current !== requestedVenueId || requestedClientRef.current !== client

  useEffect(() => {
    const controller = new AbortController()
    if (!client.clientAssistant) return () => undefined
    const generation = workspaceGenerationRef.current + 1
    workspaceGenerationRef.current = generation
    venueRequestGenerationRef.current = generation
    venueRequestRef.current?.abort()
    venueRequestRef.current = null
    requestedVenueRef.current = requestedVenueId
    requestedClientRef.current = client
    setBootstrap(null)
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: CLIENT_ASSISTANT_READ_TIMEOUT_MS,
      request: (signal) =>
        client.clientAssistant.bootstrap.query(
          requestedVenueId ? { venueId: requestedVenueId } : {},
          {
            signal,
          },
        ),
    })
      .then((result) => {
        if (!controller.signal.aborted && workspaceGenerationRef.current === generation)
          setBootstrap(result as BootstrapState)
      })
      .catch((error: unknown) => {
        if (error instanceof BoundedClientRequestError && error.code === 'CANCELLED') return
        // Optional assistance fails closed; normal portal navigation remains.
      })
    return () => {
      controller.abort()
    }
  }, [client, requestedVenueId])

  useEffect(
    () => () => {
      workspaceGenerationRef.current += 1
      venueRequestGenerationRef.current += 1
      venueRequestRef.current?.abort()
    },
    [],
  )

  const venueId = bootstrap?.selectedVenueId
  const venue = bootstrap?.venues.find((candidate) => candidate.id === venueId)
  if (bootstrapRequestChanged || !bootstrap?.available || !bootstrap.preference.enabled || !venueId)
    return null

  async function updatePreference(enabled: boolean, minimized: boolean) {
    if (!bootstrap || !venueId) throw new Error('Client assistance is not ready')
    const generation = workspaceGenerationRef.current
    const expectedRevision = bootstrap.preference.revision
    const saved = await client.clientAssistant.setPreference.mutate({
      venueId,
      enabled,
      minimized,
      expectedRevision,
    })
    setBootstrap((current) =>
      workspaceGenerationRef.current === generation &&
      current?.selectedVenueId === venueId &&
      current.preference.revision === expectedRevision
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
  }

  return (
    <ClientTochiPanel
      key={venueId}
      enabled
      minimized={bootstrap.preference.minimized}
      initialMessages={mapHistory(bootstrap.history)}
      {...(venue?.name ? { venueName: venue.name } : {})}
      venues={bootstrap.venues}
      selectedVenueId={venueId}
      onVenueChange={async (nextVenueId) => {
        venueRequestRef.current?.abort()
        const controller = new AbortController()
        const generation = workspaceGenerationRef.current + 1
        workspaceGenerationRef.current = generation
        venueRequestGenerationRef.current = generation
        venueRequestRef.current = controller
        try {
          const next = await runBoundedClientRequest({
            parentSignal: controller.signal,
            timeoutMs: CLIENT_ASSISTANT_READ_TIMEOUT_MS,
            request: (signal) =>
              client.clientAssistant.bootstrap.query({ venueId: nextVenueId }, { signal }),
          })
          if (venueRequestGenerationRef.current === generation) {
            setBootstrap(next as BootstrapState)
          }
        } finally {
          if (venueRequestGenerationRef.current === generation) {
            venueRequestRef.current = null
          }
        }
      }}
      onOpened={async () => {
        await client.clientAssistant.opened.mutate({ venueId })
      }}
      onSend={async (message) =>
        mapReply(
          await client.clientAssistant.send.mutate({
            operationId: browserUuid(),
            venueId,
            message,
          }),
        )
      }
      onConfirmHandoff={async (preview) =>
        client.clientAssistant.confirmHandoff.mutate({
          operationId: browserUuid(),
          venueId,
          turnId: preview.previewId,
          category: preview.category,
          summary: preview.summary,
          requestedOutcome: preview.requestedOutcome,
          ...(preview.relevantFeature ? { relevantFeature: preview.relevantFeature } : {}),
        })
      }
      onMinimize={() => updatePreference(true, true)}
    />
  )
}
