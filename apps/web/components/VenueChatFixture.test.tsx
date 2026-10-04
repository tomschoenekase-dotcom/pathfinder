import React from 'react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
import { DEFAULT_CHAT_APPEARANCE } from '@pathfinder/contracts/chat-appearance'
import { VenueChatFixture, VISITOR_FIXTURE_PROJECTION } from './VenueChatFixture'

describe('VenueChatFixture', () => {
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

  it('references an asset copied by the canonical character synchronization step', () => {
    const asset = VISITOR_FIXTURE_PROJECTION.assets[0]!
    const publicAsset = resolve(
      process.cwd(),
      'public',
      VISITOR_FIXTURE_PROJECTION.publicBasePath.slice(1),
      asset.path,
    )

    expect(asset.id).toBe('preview')
    expect(existsSync(publicAsset)).toBe(true)
  })

  it('keeps Classic free of the optional character stage', () => {
    const { container } = render(
      <VenueChatFixture
        mode="classic"
        state="idle"
        conversation="empty"
        asset="ok"
        motion="reduced"
      />,
    )

    expect(container.querySelector('[data-character-layout]')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Great Lakes Discovery Museum' })).toBeTruthy()
  })

  it('can render a location-aware venue with a reachable Share location action', () => {
    render(
      <VenueChatFixture
        mode="classic"
        state="idle"
        conversation="empty"
        asset="ok"
        motion="reduced"
        guideMode="location_aware"
      />,
    )

    expect(screen.getByRole('button', { name: 'Share location' })).toBeTruthy()
  })

  it('clears starter prompt separators while the guide is thinking', () => {
    const { container } = render(
      <VenueChatFixture
        mode="character"
        state="thinking"
        conversation="empty"
        asset="ok"
        motion="reduced"
      />,
    )

    expect(screen.getByRole('heading', { name: 'What can I help you find?' })).toBeTruthy()
    expect(screen.queryByText('START WITH A QUESTION')).toBeNull()
    expect(screen.queryByRole('button', { name: 'What should I know first.' })).toBeNull()
    expect(container.querySelector('section.mb-4')).toBeNull()
  })

  it('renders deterministic long-conversation and error controls', async () => {
    const { container } = render(
      <VenueChatFixture
        mode="character"
        state="error"
        conversation="long"
        asset="ok"
        motion="reduced"
      />,
    )

    expect(container.querySelector('[data-fixture-state="error"]')).toBeTruthy()
    expect(
      await screen.findByText('The character had a problem', {}, { timeout: 5_000 }),
    ).toBeTruthy()
    expect(screen.getByText('The test response could not be loaded.')).toBeTruthy()
    expect(screen.getByText('What should our family see first?')).toBeTruthy()
    expect(container.querySelector('[data-character-layout="compact"]')).toBeTruthy()
  }, 10_000)

  it('renders mixed RTL and CJK fixture content without changing its source language', () => {
    const { container } = render(
      <VenueChatFixture
        mode="classic"
        state="idle"
        conversation="multilingual"
        asset="ok"
        motion="reduced"
        network="offline"
        language="العربية"
      />,
    )

    expect(container.querySelector('[data-fixture-conversation="multilingual"]')).toBeTruthy()
    expect(screen.getByText(/هل يمكنك اقتراح/)).toBeTruthy()
    expect(screen.getByText(/子どもと一緒に/)).toBeTruthy()
    expect(container.querySelector('[lang="ar"][dir="rtl"]')).toBeTruthy()
  })

  it('renders the production Voice Mode recovery presentation without provider credentials', () => {
    render(
      <VenueChatFixture
        mode="classic"
        state="idle"
        conversation="empty"
        asset="ok"
        motion="reduced"
        voice="error"
      />,
    )

    const retryButton = screen.getByRole('button', { name: 'Try voice conversation again' })
    expect(retryButton.getAttribute('title')).toBe('Voice unavailable')
    const recoveryAlert = screen.getByRole('alert')
    expect(recoveryAlert.textContent).toContain('Microphone access was denied')
    expect(recoveryAlert.textContent).toContain('You can continue in text')
  })

  it('renders offline and reconnected guidance through the production shell', () => {
    const view = render(
      <VenueChatFixture
        mode="classic"
        state="listening"
        conversation="empty"
        asset="ok"
        motion="reduced"
        network="offline"
      />,
    )

    const offlineStatus = screen.getByText("You're offline").closest('[role="status"]')
    expect(offlineStatus?.textContent).toContain('draft stays on this screen')
    expect(
      (screen.getByRole('button', { name: 'Reconnect to send message' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect((screen.getByRole('button', { name: 'Clear chat' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Settings' }), { key: 'Escape' })

    view.rerender(
      <VenueChatFixture
        mode="classic"
        state="listening"
        conversation="empty"
        asset="ok"
        motion="reduced"
        network="reconnected"
      />,
    )
    expect(screen.getByText('Back online').closest('[role="status"]')?.textContent).toContain(
      'You can send your draft',
    )
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('removes failed chat branding and restores the unbranded header treatment', () => {
    const { container } = render(
      <VenueChatFixture
        mode="classic"
        state="idle"
        conversation="empty"
        asset="ok"
        motion="reduced"
        branding="approved"
      />,
    )

    const header = container.querySelector('header')!
    const images = header.querySelectorAll('img')
    expect(images).toHaveLength(2)

    const heading = screen.getByRole('heading', { name: 'Great Lakes Discovery Museum' })
    fireEvent.load(images[0]!)
    expect(header.getAttribute('data-branding-banner-state')).toBe('ready')
    expect(heading.closest('[data-on-banner]')).not.toBeNull()

    fireEvent.error(images[0]!)
    fireEvent.error(images[1]!)
    expect(header.querySelectorAll('img')).toHaveLength(0)
    expect(header.getAttribute('data-branding-banner-state')).toBe('failed')
    expect(heading.closest('[data-on-banner]')).toBeNull()
  })

  it('places a chosen photo behind protected reading surfaces and falls back when it fails', () => {
    const { container } = render(
      <VenueChatFixture
        mode="classic"
        state="idle"
        conversation="long"
        asset="ok"
        motion="reduced"
        backgroundUrl="/dev-fixtures/visitor-backdrop-space.svg"
        appearance={{
          ...DEFAULT_CHAT_APPEARANCE,
          userBubble: false,
          assistantBubble: false,
          background: { mode: 'image', focalX: 20, focalY: 80, dim: 40 },
        }}
      />,
    )
    const shell = container.querySelector('[data-backdrop]') as HTMLElement
    const header = container.querySelector('header')!
    expect(header.querySelector('img')).toBeNull()
    const backdrop = container.querySelector('main [aria-hidden="true"] img') as HTMLImageElement
    expect(shell.getAttribute('data-backdrop')).toBe('none')

    fireEvent.load(backdrop)
    expect(shell.getAttribute('data-backdrop')).toBe('image')
    expect(shell.style.getPropertyValue('--chat-backdrop-position')).toBe('20% 80%')
    const answers = container.querySelectorAll('article[data-role="assistant"] > div')
    expect(answers.length).toBeGreaterThan(0)
    for (const answer of answers) expect(answer.getAttribute('data-surface')).toBe('protected')
    expect(screen.getAllByText('Guide', { selector: 'p' }).length).toBe(2)

    fireEvent.error(backdrop)
    expect(shell.getAttribute('data-backdrop')).toBe('none')
    expect(container.querySelector('main [aria-hidden="true"] img')).toBeNull()
    for (const answer of container.querySelectorAll('article[data-role="assistant"] > div')) {
      expect(answer.getAttribute('data-surface')).toBe('none')
    }
  })

  it('exercises the production route planner with deterministic reviewed locations', async () => {
    render(
      <VenueChatFixture
        mode="character"
        state="idle"
        conversation="long"
        asset="ok"
        motion="reduced"
        voice="idle"
        route="ready"
      />,
    )

    const plannerToggle = await screen.findByRole('button', { name: 'Plan a route' })
    const voiceToggle = screen.getByRole('button', { name: 'Start voice conversation' })
    const conversationLog = screen.getByRole('log', { name: 'Conversation' })
    const composer = screen.getByRole('textbox', { name: 'Ask a question' })
    // The textarea sits in a hint wrapper inside the composer field row.
    const composerField = composer.parentElement?.parentElement
    expect(conversationLog.contains(plannerToggle)).toBe(true)
    expect(conversationLog.contains(voiceToggle)).toBe(false)
    expect(composerField?.contains(voiceToggle)).toBe(true)
    expect(conversationLog.contains(composer)).toBe(false)
    expect(
      plannerToggle.compareDocumentPosition(voiceToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    expect(
      composer.compareDocumentPosition(voiceToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)

    fireEvent.click(plannerToggle)
    fireEvent.click(screen.getByLabelText('Use only connections marked accessible'))
    fireEvent.click(screen.getByRole('button', { name: 'Find route' }))

    expect(await screen.findByText('Main entrance to Lake gallery')).toBeTruthy()
    expect(screen.getByText('Take the lift to the upper floor and turn left.')).toBeTruthy()
  })
})
