import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatWindow } from './ChatWindow'

describe('ChatWindow accessibility and motion behavior', () => {
  const scrollTo = vi.fn()

  beforeEach(() => {
    cleanup()
    scrollTo.mockClear()
    vi.stubGlobal('React', React)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('exposes messages as a labelled non-live conversation log', () => {
    render(
      <ChatWindow
        messages={[
          { role: 'user', content: 'Where is the gallery?' },
          { role: 'assistant', content: 'The gallery is upstairs.' },
        ]}
        onSend={vi.fn()}
        isLoading={false}
      />,
    )

    const log = screen.getByRole('log', { name: 'Conversation' })
    expect(log.getAttribute('aria-live')).toBe('off')
    expect(screen.getByText('You:')).toBeTruthy()
    expect(screen.getByText('PathFinder guide:')).toBeTruthy()
  })

  it('uses automatic direction and unknown language for free-form and restored text', () => {
    const arabicQuestion = '\u0623\u064a\u0646 \u0627\u0644\u0645\u0639\u0631\u0636\u061f'
    const arabicResponse =
      '\u0627\u0644\u0645\u0639\u0631\u0636 \u0641\u064a \u0627\u0644\u0637\u0627\u0628\u0642 \u0627\u0644\u0639\u0644\u0648\u064a.'
    const view = render(
      <ChatWindow
        messages={[
          { role: 'assistant', content: 'Historic English response.' },
          {
            role: 'user',
            content: arabicQuestion,
          },
        ]}
        onSend={vi.fn()}
        isLoading={false}
      />,
    )

    const log = screen.getByRole('log', { name: 'Conversation' })
    expect(log.hasAttribute('lang')).toBe(false)
    expect(log.hasAttribute('dir')).toBe(false)
    const composer = screen.getByRole('textbox', { name: 'Ask a question' })
    expect(composer.getAttribute('lang')).toBe('')
    expect(composer.getAttribute('dir')).toBe('auto')

    const currentText = screen.getByText(arabicQuestion)
    expect(currentText.getAttribute('lang')).toBe('')
    expect(currentText.getAttribute('dir')).toBe('auto')
    const historicText = screen.getByText('Historic English response.')
    expect(historicText.getAttribute('lang')).toBe('')
    expect(historicText.getAttribute('dir')).toBe('auto')

    view.rerender(
      <ChatWindow
        messages={[
          { role: 'assistant', content: 'Historic English response.' },
          {
            role: 'user',
            content: arabicQuestion,
          },
          {
            role: 'assistant',
            content: arabicResponse,
          },
        ]}
        onSend={vi.fn()}
        isLoading={false}
      />,
    )
    const announcedResponse = screen.getByRole('status').querySelector('span[lang=""][dir="auto"]')
    expect(announcedResponse?.textContent).toBe(arabicResponse)
  })

  it('announces send failures and gives the busy send button a name', () => {
    const view = render(
      <ChatWindow
        messages={[]}
        onSend={vi.fn()}
        isLoading
        errorMessage="The guide could not respond."
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain('The guide could not respond.')
    expect(screen.getByRole('button', { name: 'Sending message' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('PathFinder guide is responding')

    view.rerender(
      <ChatWindow
        messages={[]}
        onSend={vi.fn()}
        isLoading={false}
        errorMessage="The guide could not respond."
      />,
    )

    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.getByRole('alert').textContent).toContain('The guide could not respond.')
  })

  it('does not announce restored history but announces a newly added response', () => {
    const history = [{ role: 'assistant' as const, content: 'Earlier answer.' }]
    const view = render(<ChatWindow messages={history} onSend={vi.fn()} isLoading={false} />)

    expect(screen.getByRole('status').textContent).toBe('')

    view.rerender(
      <ChatWindow
        messages={[
          ...history,
          { role: 'user', content: 'A new question.' },
          { role: 'assistant', content: 'A new answer.' },
        ]}
        onSend={vi.fn()}
        isLoading={false}
      />,
    )

    expect(screen.getByRole('status').textContent).toBe('PathFinder guide: A new answer.')
  })

  it('restores focus to the composer after a request finishes', () => {
    const onSend = vi.fn()
    const view = render(<ChatWindow messages={[]} onSend={onSend} isLoading={false} />)
    const composer = screen.getByRole('textbox', { name: 'Ask a question' })
    composer.focus()
    fireEvent.change(composer, { target: { value: 'Where is the gallery?' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    view.rerender(<ChatWindow messages={[]} onSend={onSend} isLoading />)
    view.rerender(<ChatWindow messages={[]} onSend={onSend} isLoading={false} />)

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Ask a question' }))
  })

  it('does not steal focus moved to another control while a request is running', () => {
    const onSend = vi.fn()
    const renderChat = (isLoading: boolean) => (
      <>
        <button type="button">Language settings</button>
        <ChatWindow messages={[]} onSend={onSend} isLoading={isLoading} />
      </>
    )
    const view = render(renderChat(false))
    const composer = screen.getByRole('textbox', { name: 'Ask a question' })
    fireEvent.change(composer, { target: { value: 'Where is the gallery?' } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    view.rerender(renderChat(true))
    const otherControl = screen.getByRole('button', { name: 'Language settings' })
    otherControl.focus()
    view.rerender(renderChat(false))

    expect(document.activeElement).toBe(otherControl)
  })

  it('uses instant scrolling when reduced motion is requested', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList)

    render(
      <ChatWindow
        messages={[{ role: 'assistant', content: 'Welcome.' }]}
        onSend={vi.fn()}
        isLoading={false}
      />,
    )

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }))
  })

  it('submits trimmed text and clears the composer', () => {
    const onSend = vi.fn()
    render(<ChatWindow messages={[]} onSend={onSend} isLoading={false} />)

    const composer = screen.getByRole('textbox', { name: 'Ask a question' })
    fireEvent.change(composer, { target: { value: '  Is there a cafe?  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(onSend).toHaveBeenCalledWith('Is there a cafe?')
    expect((composer as HTMLTextAreaElement).value).toBe('')
  })

  it('renders descriptive cards without coordinates and records a real details action', () => {
    const onPlaceCardClick = vi.fn()
    render(
      <ChatWindow
        messages={[
          {
            role: 'assistant',
            content: 'Visit the East Gallery for the textile collection.',
            places: [
              {
                id: 'place-1',
                name: 'East Gallery',
                type: 'EXHIBIT',
                photoUrl: null,
                shortDescription: 'Rotating textiles from the permanent collection.',
                areaName: 'Second floor',
                hours: '10:00 AM–4:00 PM',
                distanceMeters: undefined,
                lat: null,
                lng: null,
              },
            ],
          },
        ]}
        onSend={vi.fn()}
        isLoading={false}
        onPlaceCardClick={onPlaceCardClick}
      />,
    )

    expect(screen.getByRole('article', { name: 'East Gallery' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Get directions to East Gallery' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show details for East Gallery' }))
    expect(screen.getByText('Rotating textiles from the permanent collection.')).toBeTruthy()
    expect(screen.getByText(/Second floor/)).toBeTruthy()
    expect(screen.getByText(/10:00 AM–4:00 PM/)).toBeTruthy()
    expect(onPlaceCardClick).toHaveBeenCalledOnce()
    expect(onPlaceCardClick).toHaveBeenCalledWith('place-1')
  })
})
