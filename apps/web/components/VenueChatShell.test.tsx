import React, { type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

import { VenueChatShell } from './VenueChatShell'

type ShellProps = ComponentProps<typeof VenueChatShell>

function props(overrides: Partial<ShellProps> = {}): ShellProps {
  return {
    venue: {
      id: 'shell-test-museum',
      name: 'The Museum of Small and Remarkable Things',
      description: 'Explore the miniature collection and the workshop gallery.',
      category: 'museum',
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      aiGuideName: null,
      chatTheme: 'light',
      chatAccentColor: null,
      chatFont: null,
      chatLogoUrl: null,
      chatBannerUrl: null,
    },
    venueSlug: 'shell-test-museum',
    presentation: 'standalone',
    messages: [],
    isSending: false,
    sendError: null,
    anonymousToken: 'shell-test-visitor',
    language: 'English',
    setLanguage: vi.fn(),
    initialDraft: '',
    location: { lat: null, lng: null, permission: 'prompt', refresh: vi.fn() },
    onSend: vi.fn(),
    onNewConversation: vi.fn(),
    onPlaceView: vi.fn(),
    onPlaceClick: vi.fn(),
    onDirections: vi.fn(),
    voiceControl: null,
    ...overrides,
  }
}

describe('VenueChatShell text-first presentation', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    HTMLElement.prototype.scrollTo = vi.fn()
    window.sessionStorage.clear()
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('never mounts the retired visit form, even from an older caller', () => {
    const mounted = vi.fn()
    function RetiredForm() {
      mounted()
      return <button>Your visit — tell us about yourself</button>
    }
    render(<VenueChatShell {...props({ visitPreferences: <RetiredForm /> })} />)
    expect(mounted).not.toHaveBeenCalled()
    expect(screen.queryByText(/Your visit|tell us about yourself/u)).toBeNull()
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Ask a question' })).toBeTruthy()
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /profile|preferences|fresh visit/iu })).toBeNull()
  })

  it('keeps the venue identity and one unambiguous AI disclosure without a repeated generic subtitle', () => {
    const { container } = render(<VenueChatShell {...props()} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'The Museum of Small and Remarkable Things',
    )
    expect(container.querySelector('header')?.textContent).not.toContain('AI guidance')
    const disclosure = screen.getByText('AI guidance')
    expect(disclosure.tagName).toBe('SUMMARY')
    expect(disclosure.closest('details')?.open).toBe(false)
    fireEvent.click(disclosure)
    expect(disclosure.closest('details')?.open).toBe(true)
    expect(screen.getByRole('note', { name: 'AI guidance' }).textContent).toContain(
      'AI-generated answers can be wrong',
    )
  })

  it('retains a venue-authored guide name and description', () => {
    const input = props()
    input.venue = { ...input.venue, aiGuideName: 'Mira' }
    const { container } = render(<VenueChatShell {...input} />)
    expect(container.querySelector('header')?.textContent).toContain('Mira')
    expect(screen.getByText(input.venue.description!)).toBeTruthy()
  })

  it('keeps context in the ordinary question and preserves explicit language selection', () => {
    const input = props()
    render(<VenueChatShell {...input} />)
    const question = 'We have twenty minutes and a five-year-old. What should we see?'
    fireEvent.change(screen.getByRole('textbox'), { target: { value: question } })
    expect(input.onSend).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '日本語' } })
    expect(input.setLanguage).toHaveBeenCalledWith('日本語')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(input.onSend).toHaveBeenCalledOnce()
    expect(input.onSend).toHaveBeenCalledWith(question)
  })

  it('preserves route and voice slots but never introduces them into text-only Classic', () => {
    const view = render(<VenueChatShell {...props()} />)
    expect(view.container.querySelector('[data-character-layout]')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Voice controls' })).toBeNull()
    view.rerender(
      <VenueChatShell
        {...props({
          routePlanner: <button>Admitted route control</button>,
          voiceControl: <button>Admitted voice control</button>,
        })}
      />,
    )
    expect(
      within(screen.getByRole('log')).getByRole('button', { name: 'Admitted route control' }),
    ).toBeTruthy()
    expect(
      within(screen.getByRole('region', { name: 'Voice controls' })).getByRole('button', {
        name: 'Admitted voice control',
      }),
    ).toBeTruthy()
  })

  it('preserves the visible Stop action and the next-question draft while busy', () => {
    const input = props({
      isSending: true,
      onStopResponse: vi.fn(),
      stopResponseLabel: 'Stop response',
    })
    render(<VenueChatShell {...input} />)
    const stop = screen.getByRole('button', { name: 'Stop response' })
    expect(stop.textContent).toContain('Stop response')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A question for later' } })
    fireEvent.click(stop)
    expect(input.onStopResponse).toHaveBeenCalledOnce()
    expect(input.onSend).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('A question for later')
    expect(screen.queryByRole('region', { name: 'Start with a question' })).toBeNull()
  })

  it('retains scoped draft recovery and does not send it after a remount', () => {
    const input = props()
    const view = render(<VenueChatShell {...input} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } })
    view.unmount()
    render(<VenueChatShell {...input} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this draft')
    expect(input.onSend).not.toHaveBeenCalled()
  })

  it('keeps failed-history recovery findable while new sends stay fenced', () => {
    const input = props({
      sendError: 'Current history could not be confirmed. Check the conversation.',
      conversationLocked: true,
      onRetry: vi.fn(),
      retryLabel: 'Check conversation',
    })
    render(<VenueChatShell {...input} />)
    expect(screen.queryByRole('region', { name: 'Start with a question' })).toBeNull()
    fireEvent.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Check conversation' }),
    )
    expect(input.onRetry).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Still editable' } })
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(input.onSend).not.toHaveBeenCalled()
  })
})
