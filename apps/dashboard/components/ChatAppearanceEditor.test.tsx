/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHAT_APPEARANCE, type ChatAppearance } from '@pathfinder/contracts/chat-appearance'
import { getChatPalette } from '@pathfinder/ui/theme'

import { ChatAppearanceEditor } from './ChatAppearanceEditor'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

function Harness({
  initial = DEFAULT_CHAT_APPEARANCE,
  backgroundAvailable = true,
  onChange = vi.fn(),
}: {
  initial?: ChatAppearance
  backgroundAvailable?: boolean
  onChange?: (value: ChatAppearance) => void
}) {
  const [value, setValue] = React.useState(initial)
  return (
    <ChatAppearanceEditor
      value={value}
      onChange={(next) => {
        onChange(next)
        setValue(next)
      }}
      palette={getChatPalette('default', null)}
      venueName="City Zoo"
      backgroundAvailable={backgroundAvailable}
      backgroundImageUrl={backgroundAvailable ? 'https://web.example.test/api/venue-media/x' : null}
    />
  )
}

describe('ChatAppearanceEditor', () => {
  afterEach(() => cleanup())

  it('offers presets first and marks the plain default as Clean', () => {
    render(<Harness />)
    const presets = screen.getByRole('group', { name: 'Chat style presets' })
    expect(
      within(presets).getByRole('button', { name: /Clean/u }).getAttribute('aria-pressed'),
    ).toBe('true')
    fireEvent.click(within(presets).getByRole('button', { name: /Text only/u }))
    expect(
      within(presets)
        .getByRole('button', { name: /Text only/u })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    const sample = screen.getByText(
      'Live sample of the visitor chat with these settings.',
    ).parentElement!
    expect(within(sample).getByText('You')).toBeTruthy()
    expect(within(sample).getByText('Guide')).toBeTruthy()
  })

  it('requires a reviewed banner before a photo backdrop can be chosen', () => {
    render(<Harness backgroundAvailable={false} />)
    const photo = screen.getByRole('button', { name: /Photo backdrop/u }) as HTMLButtonElement
    expect(photo.disabled).toBe(true)
    expect(photo.textContent).toContain('Select a reviewed banner image first.')
    expect(
      (
        screen.getByRole('switch', {
          name: 'Use the reviewed banner as the chat background',
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true)
  })

  it('applies the photo preset with a dark frame and protected answers', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Photo backdrop/u }))
    const next = onChange.mock.calls.at(-1)![0] as ChatAppearance
    expect(next.background.mode).toBe('image')
    expect(next.headerColor).toMatch(/^#[0-9a-f]{6}$/iu)
    expect(next.assistantSurfaceColor).toMatch(/^#[0-9a-f]{6}$/iu)
  })

  it('warns when a chosen text colour would be unreadable and shows the correction', () => {
    render(
      <Harness
        initial={{
          ...DEFAULT_CHAT_APPEARANCE,
          assistantBubble: true,
          assistantSurfaceColor: '#FFFFFF',
          assistantTextColor: '#EEEEEE',
        }}
      />,
    )
    const warning = screen.getByRole('status')
    expect(warning.textContent).toContain('Adjusted for readability')
    expect(warning.textContent).toContain('Guide text colour #EEEEEE')
  })

  it('edits advanced controls including title, follow-up toggle and linked bottom bar', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByText('Advanced colours and layout'))
    fireEvent.change(screen.getByLabelText('Title shown to visitors'), {
      target: { value: 'City Zoo Guide' },
    })
    expect(onChange.mock.calls.at(-1)![0].title).toBe('City Zoo Guide')
    fireEvent.click(screen.getByRole('switch', { name: /Tell me more about that/u }))
    expect(onChange.mock.calls.at(-1)![0].requestMore).toBe(false)
    fireEvent.change(screen.getByLabelText('Header'), { target: { value: '#0B1426' } })
    expect(onChange.mock.calls.at(-1)![0].headerColor).toBe('#0B1426')
    const linked = screen.getByRole('switch', { name: 'Bottom bar matches the header' })
    expect((linked as HTMLInputElement).checked).toBe(true)
    fireEvent.click(linked)
    expect(onChange.mock.calls.at(-1)![0].footerColor).toBe('#0B1426')
    expect(screen.getByLabelText('Bottom bar')).toBeTruthy()
  })
})
