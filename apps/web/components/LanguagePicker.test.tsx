import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getChatLanguagePresentation,
  getStoredLanguage,
  LanguagePicker,
  SUPPORTED_LANGUAGES,
} from './LanguagePicker'
import { localizeVisitorShellError } from './visitor-ui-copy'

describe('LanguagePicker storage resilience', () => {
  beforeEach(() => {
    cleanup()
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('treats denied storage reads as no saved preference', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })

    expect(getStoredLanguage()).toBeNull()
  })

  it('still changes language when saving the preference is denied', () => {
    const onChange = vi.fn()
    const nextLanguage = SUPPORTED_LANGUAGES.find((language) => language.label !== 'English')!
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })

    render(<LanguagePicker value="English" onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Select language' }), {
      target: { value: nextLanguage.label },
    })

    expect(onChange).toHaveBeenCalledWith(nextLanguage.label)
  })

  it('maps every supported label to its exact language code and only Arabic to RTL', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(getChatLanguagePresentation(language.label)).toEqual({
        code: language.code,
        direction: language.code === 'ar' ? 'rtl' : 'ltr',
      })
    }
  })

  it('marks the selected value and every option with language semantics', () => {
    const arabic = SUPPORTED_LANGUAGES.find((language) => language.code === 'ar')!
    render(<LanguagePicker value={arabic.label} onChange={vi.fn()} />)

    const picker = screen.getByRole('combobox', { name: 'اختيار اللغة' })
    expect(picker.className).toContain('min-h-11')
    expect(picker.getAttribute('lang')).toBe('ar')
    expect(picker.getAttribute('dir')).toBe('rtl')
    const labelId = picker.getAttribute('aria-labelledby')
    const label = labelId ? document.getElementById(labelId) : null
    expect(label?.textContent).toBe('اختيار اللغة')
    expect(label?.getAttribute('lang')).toBe('ar')
    expect(label?.getAttribute('dir')).toBe('rtl')

    for (const option of Array.from((picker as HTMLSelectElement).options)) {
      const supported = SUPPORTED_LANGUAGES.find((language) => language.label === option.value)!
      expect(option.lang).toBe(supported.code)
      expect(option.dir).toBe(supported.code === 'ar' ? 'rtl' : 'ltr')
    }
  })

  it('localizes the governed transient recovery message after an in-page language switch', () => {
    expect(
      localizeVisitorShellError(
        'The guide could not start this message. Wait a moment, then send it again as a new message.',
        'العربية',
      ),
    ).toBe('تعذر على الدليل بدء معالجة هذه الرسالة. انتظر لحظة ثم أرسلها مرة أخرى كرسالة جديدة.')
    expect(
      localizeVisitorShellError(
        'This message was not sent because the guide is busy. Wait a moment, then retry the same message.',
        'العربية',
      ),
    ).toBe('لم تُرسل الرسالة لأن الدليل مشغول. انتظر لحظة ثم أعد محاولة الرسالة نفسها.')
    expect(localizeVisitorShellError('Unknown safe server message.', 'العربية')).toBe(
      'Unknown safe server message.',
    )
  })
})
