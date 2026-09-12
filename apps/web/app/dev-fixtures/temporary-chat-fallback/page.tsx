'use client'

import { notFound } from 'next/navigation'
import type { CSSProperties } from 'react'

import { ChatWindow } from '../../../components/ChatWindow'

export default function TemporaryChatFallbackFixturePage() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <main
      data-testid="temporary-chat-fallback-fixture"
      className="mx-auto flex min-h-screen w-full max-w-2xl flex-col bg-stone-50 p-4 sm:p-8"
      style={
        {
          '--chat-accent': '#245a4a',
          '--chat-accent-contrast': '#ffffff',
          '--chat-accent-text': '#1c463a',
          '--chat-bg': '#ffffff',
          '--chat-border': '#d6ddd8',
          '--chat-card': '#f5f7f5',
          '--chat-text': '#1f2933',
          '--chat-text-muted': '#5c6972',
        } as CSSProperties
      }
    >
      <ChatWindow
        messages={[
          {
            id: 'fixture-temporary-fallback',
            role: 'assistant',
            content: "I'm having trouble right now. Please try again in a moment.",
            replyKind: 'TEMPORARY_FALLBACK',
          },
        ]}
        onSend={() => undefined}
        onRequestMore={() => undefined}
        onMessageFeedback={async () => undefined}
        isLoading={false}
        assistantLabel="Museum guide"
      />
    </main>
  )
}
