import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VisitorSettings, type VisitorSettingsProps } from './VisitorSettings'
import { DEFAULT_VISITOR_PREFERENCES } from '../lib/visitor-preferences'

function renderSettings(
  overrides: Partial<VisitorSettingsProps> = {},
  { withClearChat = true }: { withClearChat?: boolean } = {},
) {
  const props: VisitorSettingsProps = {
    language: 'English',
    preferences: DEFAULT_VISITOR_PREFERENCES,
    onPreferencesChange: vi.fn(),
    ...(withClearChat ? { onClearChat: vi.fn() } : {}),
    clearChatLabel: 'Clear chat',
    aboutGuidance: 'AI-generated answers can be wrong.',
    poweredByLabel: 'Powered by',
    attribution: 'link',
    ...overrides,
  }
  return { ...render(<VisitorSettings {...props} />), props }
}

describe('VisitorSettings', () => {
  beforeEach(() => vi.stubGlobal('React', React))
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps only a small AI disclosure and a Settings entry in view', () => {
    renderSettings()
    expect(screen.getByText('AI guide')).toBeTruthy()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('AI-generated answers can be wrong.')).toBeNull()
  })

  it('shows Voice conversation only when the venue is eligible and keeps it on by default', () => {
    renderSettings({ voiceAvailable: true })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const toggle = within(screen.getByRole('dialog')).getByRole('switch', {
      name: 'Voice conversation',
    }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  it('hides voice settings for ineligible venues and reports the visitor choice', () => {
    renderSettings({ voiceAvailable: false })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(within(screen.getByRole('dialog')).queryByText('Voice conversation')).toBeNull()
    cleanup()
    const eligible = renderSettings({ voiceAvailable: true, onVoiceConversationChange: vi.fn() })
    fireEvent.click(within(eligible.container).getByRole('button', { name: 'Settings' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('switch', { name: 'Voice conversation' }),
    )
    expect(eligible.props.onVoiceConversationChange).toHaveBeenCalledWith(false)
  })

  it('offers text size, Auto language, high contrast, Clear chat and About', () => {
    const { props } = renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Larger' }))
    expect(props.onPreferencesChange).toHaveBeenCalledWith({ textSize: 'larger' })

    const language = within(dialog).getByRole('combobox', { name: 'Language' }) as HTMLSelectElement
    expect(language.value).toBe('auto')
    expect(language.options[0]?.textContent).toMatch(/^Automatic/u)
    expect(within(dialog).getByText('Replies follow the language you write in.')).toBeTruthy()
    fireEvent.change(language, { target: { value: 'Français' } })
    expect(props.onPreferencesChange).toHaveBeenCalledWith({ language: 'Français' })

    fireEvent.click(within(dialog).getByRole('switch', { name: /High contrast/u }))
    expect(props.onPreferencesChange).toHaveBeenCalledWith({ highContrast: true })

    expect(within(dialog).getByRole('heading', { name: 'About this guide' })).toBeTruthy()
    expect(within(dialog).getByRole('note').textContent).toBe('AI-generated answers can be wrong.')
    expect(within(dialog).getByRole('link', { name: 'Torchiko' }).getAttribute('href')).toBe(
      'https://torchiko.com',
    )
  })

  it('closes before asking to clear, so confirmation owns the next focus', () => {
    vi.useFakeTimers()
    const { props } = renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement?.textContent).toBe('Settings')
    expect(props.onClearChat).not.toHaveBeenCalled()
    act(() => vi.runAllTimers())
    expect(props.onClearChat).toHaveBeenCalledOnce()
  })

  it('traps focus, closes on Escape and returns focus to Settings', () => {
    renderSettings()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    const close = within(dialog).getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(close)

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement?.textContent).toBe('Torchiko')
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('omits Clear chat where there is no conversation and hides attribution in app webviews', () => {
    renderSettings({ attribution: 'none' }, { withClearChat: false })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByRole('button', { name: 'Clear chat' })).toBeNull()
    expect(screen.queryByText(/Powered by/u)).toBeNull()
  })

  it('localizes and mirrors the sheet for Arabic', () => {
    renderSettings({ language: 'العربية' })
    fireEvent.click(screen.getByRole('button', { name: 'الإعدادات' }))
    const dialog = screen.getByRole('dialog', { name: 'الإعدادات' })
    expect(dialog.getAttribute('dir')).toBe('rtl')
    expect(dialog.getAttribute('lang')).toBe('ar')
    expect(within(dialog).getByRole('heading', { name: 'حول هذا الدليل' })).toBeTruthy()
  })
})
