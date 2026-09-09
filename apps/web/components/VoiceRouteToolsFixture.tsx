'use client'

import { useState } from 'react'

import { TRPCProvider } from '../lib/trpc'
import { VoiceControl } from './VoiceControl'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const ANONYMOUS_TOKEN = '123e4567-e89b-42d3-a456-426614174000'

export function VoiceRouteToolsFixture() {
  const [lastEvent, setLastEvent] = useState('Ready for a local voice session.')

  return (
    <TRPCProvider scopeKey="voice-route-tools-fixture">
      <main className="min-h-screen bg-[var(--chat-background,#f7f5ef)] px-5 py-8 text-[var(--chat-text,#1d2722)] sm:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <header className="border-b border-black/10 pb-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-black/55">
              Local interaction proof
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Voice route tools
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-black/65">
              A development-only voice session for the browser proof harness, with deterministic
              venue answers.
            </p>
          </header>

          <section aria-labelledby="voice-proof-heading" className="max-w-xl">
            <h2 id="voice-proof-heading" className="text-base font-semibold">
              Visitor voice
            </h2>
            <p className="mt-1 text-sm text-black/60">
              The browser test supplies simulated media and venue responses; this page does not
              simulate transport itself.
            </p>
            <div className="mt-4">
              <VoiceControl
                venueId={VENUE_ID}
                anonymousToken={ANONYMOUS_TOKEN}
                language="English"
                disabled={false}
                onCharacterState={(state) => setLastEvent(`Voice state: ${state}`)}
              />
            </div>
            <p
              className="mt-4 text-xs text-black/55"
              data-testid="voice-route-last-event"
              role="status"
              aria-live="polite"
            >
              {lastEvent}
            </p>
          </section>
        </div>
      </main>
    </TRPCProvider>
  )
}
