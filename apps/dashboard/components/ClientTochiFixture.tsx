'use client'

import React from 'react'

import {
  ClientTochiPanel,
  type ClientTochiMessage,
  type ClientTochiReply,
} from './ClientTochiPanel'

export type ClientTochiFixtureState =
  | 'empty'
  | 'history'
  | 'handoff'
  | 'failure'
  | 'minimized'
  | 'disabled'

const HISTORY: ClientTochiMessage[] = [
  { id: 'fixture-user-1', role: 'user', body: 'Did you get our visitor guide?' },
  {
    id: 'fixture-assistant-1',
    role: 'assistant',
    body: 'Yes. Visitor guide.pdf is in the materials Torchiko received for this venue.',
    action: { type: 'navigate', href: '/information', label: 'Open Information' },
  },
]

const HANDOFF: ClientTochiMessage[] = [
  { id: 'fixture-user-2', role: 'user', body: 'Can we connect our POS system?' },
  {
    id: 'fixture-turn-handoff',
    role: 'assistant',
    body: 'I cannot promise that connection from here. I prepared a request for you to review before anything is sent.',
    action: {
      type: 'preview-support-handoff',
      preview: {
        previewId: 'fixture-turn-handoff',
        category: 'OPERATIONAL_UPDATE',
        summary: 'Review POS integration options',
        requestedOutcome: 'Confirm whether the venue POS can connect to Venue Bot.',
        relevantFeature: 'Venue Bot integrations',
      },
    },
  },
]

export function ClientTochiFixture({ state }: { state: ClientTochiFixtureState }) {
  const initialMessages = state === 'handoff' ? HANDOFF : state === 'history' ? HISTORY : []

  async function reply(message: string): Promise<ClientTochiReply> {
    if (state === 'failure') throw new Error('Fixture failure')
    return {
      id: 'fixture-reply',
      answer: `I received your question: “${message}”. This fixture does not read client data.`,
    }
  }

  return (
    <ClientTochiPanel
      enabled={state !== 'disabled'}
      minimized={state === 'minimized'}
      initialOpen={state !== 'disabled' && state !== 'minimized'}
      initialMessages={initialMessages}
      venueName="Great Lakes Discovery Museum"
      onSend={reply}
      onConfirmHandoff={async () => ({ requestId: 'fixture-request' })}
      onMinimize={async () => undefined}
    />
  )
}
