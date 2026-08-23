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
    expect(screen.getByRole('heading', { name: 'Museum Guide' })).toBeTruthy()
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

    expect(screen.getByRole('button', { name: 'Try voice conversation again' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Microphone access was denied')
    expect(screen.getByText('Voice stopped safely. Text chat is still available.')).toBeTruthy()
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
    expect(
      (screen.getByRole('button', { name: 'New conversation' }) as HTMLButtonElement).disabled,
    ).toBe(true)

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

  it('exercises the production route planner with deterministic reviewed locations', async () => {
    render(
      <VenueChatFixture
        mode="character"
        state="idle"
        conversation="long"
        asset="ok"
        motion="reduced"
        route="ready"
      />,
    )

    const plannerToggle = await screen.findByRole('button', { name: 'Plan a route' })
    fireEvent.click(plannerToggle)
    fireEvent.click(screen.getByLabelText('Use only connections marked accessible'))
    fireEvent.click(screen.getByRole('button', { name: 'Find route' }))

    expect(await screen.findByText('Main entrance to Lake gallery')).toBeTruthy()
    expect(screen.getByText('Take the lift to the upper floor and turn left.')).toBeTruthy()
  })
})
