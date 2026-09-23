'use client'

import { useEffect, useState } from 'react'

import { supportCreateDraft } from '../lib/support-create-intent'
import { buildGuestChatUrl } from '../lib/guest-chat-url'
import { useTRPCClient } from '../lib/trpc'
import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { SupportWorkspace } from './SupportWorkspace'
import { VenueQrKitAvailability } from './VenueQrKitAvailability'

type LoadedState = {
  venue: { id: string; name: string; slug: string }
  venues: Array<{ id: string; name: string }>
  lifecycleState: string
  hasCurrentRelease: boolean
  guestChatUrl: string | null
  requests: Awaited<
    ReturnType<ReturnType<typeof useTRPCClient>['support']['listRequests']['query']>
  >
  attachments: Awaited<
    ReturnType<ReturnType<typeof useTRPCClient>['support']['listEligibleAttachments']['query']>
  >
}

export function ConnectedClientHandoffFixture({
  venueId,
  newIntent,
}: {
  venueId: string
  newIntent?: string | string[]
}) {
  const client = useTRPCClient()
  const [loaded, setLoaded] = useState<LoadedState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setError(null)
      setLoaded(null)
      try {
        const [venueRows, lifecycleRows] = await runBoundedClientRequest({
          parentSignal: controller.signal,
          timeoutMs: 15_000,
          request: (signal) =>
            Promise.all([
              client.venue.list.query(undefined, { signal }),
              client.portal.getVenueLifecycles.query(undefined, { signal }),
            ]),
        })
        const venue = venueRows.find((candidate) => candidate.id === venueId)
        const lifecycle = lifecycleRows.find((candidate) => candidate.venueId === venueId)
        if (!venue || !lifecycle) throw new Error('Scoped venue evidence is unavailable')
        const guestChatUrl = buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, venue.slug, {
          allowLoopbackHttp: process.env.NODE_ENV === 'development',
        })
        const [requests, attachments] = await runBoundedClientRequest({
          parentSignal: controller.signal,
          timeoutMs: 15_000,
          request: (signal) =>
            Promise.all([
              client.support.listRequests.query({ venueId }, { signal }),
              client.support.listEligibleAttachments.query({ venueId, limit: 20 }, { signal }),
            ]),
        })
        if (controller.signal.aborted) return
        setLoaded({
          venue,
          venues: venueRows.map(({ id, name }) => ({ id, name })),
          lifecycleState: lifecycle.lifecycle.state,
          hasCurrentRelease: lifecycle.release.released,
          guestChatUrl,
          requests,
          attachments,
        })
      } catch {
        if (!controller.signal.aborted) {
          setError('The connected venue handoff could not be loaded. Nothing was sent.')
        }
      }
    }
    void load()
    return () => controller.abort()
  }, [client, venueId])

  if (error) {
    return (
      <main className="min-h-screen bg-pf-surface px-4 py-8 sm:px-7 sm:py-12">
        <p role="alert" className="mx-auto max-w-3xl border-l-2 border-red-500 bg-white p-5">
          {error}
        </p>
      </main>
    )
  }
  if (!loaded || loaded.venue.id !== venueId) {
    return (
      <main className="min-h-screen bg-pf-surface px-4 py-8 sm:px-7 sm:py-12">
        <p role="status" className="mx-auto max-w-3xl text-sm text-pf-deep/70">
          Loading the connected venue handoff…
        </p>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-pf-surface px-4 py-8 sm:px-7 sm:py-12">
      <div className="mx-auto max-w-6xl space-y-10">
        <header className="max-w-3xl border-l-2 border-pf-primary pl-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
            Development fixture · connected disposable data
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep sm:text-4xl">
            {loaded.venue.name}
          </h1>
          <p className="mt-3 text-sm leading-6 text-pf-deep/75">
            This page reads the venue’s saved lifecycle and support records. The form below is an
            unsent draft until you choose Send request.
          </p>
        </header>

        <VenueQrKitAvailability
          venueId={loaded.venue.id}
          venueName={loaded.venue.name}
          lifecycleState={loaded.lifecycleState}
          hasCurrentRelease={loaded.hasCurrentRelease}
          guestChatUrl={loaded.guestChatUrl}
          generatedAt={new Date().toISOString()}
        />

        <section aria-labelledby="connected-support-heading">
          <div className="mb-5 max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
              Factual handoff
            </p>
            <h2 id="connected-support-heading" className="mt-2 text-2xl font-semibold text-pf-deep">
              Ask about this saved draft
            </h2>
          </div>
          <SupportWorkspace
            key={loaded.venue.id}
            venues={loaded.venues}
            activeVenue={{ id: loaded.venue.id, name: loaded.venue.name }}
            initialRequests={loaded.requests.items}
            initialNextCursor={loaded.requests.nextCursor}
            initialDetail={null}
            initialEligibleAttachments={loaded.attachments.items}
            initialEligibleAttachmentsNextCursor={loaded.attachments.nextCursor}
            initialCreateDraft={
              supportCreateDraft({
                intent: newIntent,
                hasRequestedRequest: false,
                requestedVenueId: venueId,
                selectedVenueId: loaded.venue.id,
              }) ?? {
                category: 'GENERAL',
                subject: 'Draft visibility and QR readiness',
              }
            }
          />
        </section>
      </div>
    </main>
  )
}
