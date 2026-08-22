/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResponseRenderer } from './ResponseRenderer'
import { VenueChatShell } from './VenueChatShell'

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('./VoiceControl', () => ({ VoiceControl: () => null }))

async function expectNoAutomatedViolations(container: HTMLElement) {
  expect(document.body.contains(container)).toBe(true)
  document.documentElement.lang = 'en'
  document.title = 'Torchiko guest accessibility contract'
  const result = await axe.run(document, {
    rules: {
      // jsdom has no layout or computed pixel colors. Real-browser contrast remains a separate gate.
      'color-contrast': { enabled: false },
    },
  })
  expect(
    result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
  ).toEqual([])
}

describe('Packet 2 guest automated accessibility', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    HTMLElement.prototype.scrollTo = vi.fn()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('finds no automated violations in a structured guest answer', async () => {
    const { container } = render(
      <main>
        <ResponseRenderer
          content=""
          blocks={[
            { type: 'text', text: 'Plan your visit.' },
            {
              type: 'callout',
              tone: 'info',
              title: 'Quiet morning',
              text: 'The east gallery is usually calm before noon.',
            },
            {
              type: 'choices',
              label: 'What would you like next?',
              choices: [
                {
                  id: 'hours',
                  label: 'Opening hours',
                  accessibleLabel: 'Ask about opening hours',
                  value: 'What are today’s opening hours?',
                },
              ],
            },
            {
              type: 'actions',
              actions: [
                {
                  label: 'Visitor information',
                  href: 'https://museum.example/visit',
                  style: 'primary',
                },
              ],
            },
          ]}
        />
      </main>,
    )

    await expectNoAutomatedViolations(container)
  })

  it('finds no automated violations in the offline standalone guest chat shell', async () => {
    const { container } = render(
      <VenueChatShell
        venue={{
          id: 'east-museum',
          name: 'East Museum',
          description: 'A welcoming guide to the collection.',
          category: 'MUSEUM',
          guideMode: 'non_location',
          defaultCenterLat: null,
          defaultCenterLng: null,
          aiGuideName: 'East Museum Guide',
          chatTheme: null,
          chatAccentColor: null,
          chatFont: null,
          chatLogoUrl: null,
          chatBannerUrl: null,
        }}
        venueSlug="east-museum"
        presentation="standalone"
        messages={[]}
        isSending={false}
        sendError="The outcome of this message is not confirmed. Retry the same message safely."
        anonymousToken="private-session-token"
        language="English"
        setLanguage={vi.fn()}
        initialDraft="Keep this question available"
        connectionState="offline"
        location={{ lat: null, lng: null, permission: 'denied', refresh: vi.fn() }}
        onSend={vi.fn()}
        onDraftChange={vi.fn()}
        onRetry={vi.fn()}
        onNewConversation={vi.fn()}
        onPlaceView={vi.fn()}
        onPlaceClick={vi.fn()}
        onDirections={vi.fn()}
      />,
    )

    await expectNoAutomatedViolations(container)
  })
})
