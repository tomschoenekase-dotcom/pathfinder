import React from 'react'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getChatLanguagePresentation,
  getStoredLanguage,
  SUPPORTED_LANGUAGES,
} from './LanguagePicker'
import { localizeVisitorShellError } from './visitor-ui-copy'

describe('visitor language helpers', () => {
  beforeEach(() => {
    cleanup()
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('falls back to the browser language when saved preferences cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-CA', 'en'])

    expect(getStoredLanguage()).toBe('Français')
  })

  it('returns a manual Settings choice before the browser language', () => {
    window.localStorage.setItem(
      'torchiko:visitor-preferences',
      JSON.stringify({ language: '日本語', textSize: 'standard', highContrast: false }),
    )
    try {
      expect(getStoredLanguage()).toBe('日本語')
    } finally {
      window.localStorage.removeItem('torchiko:visitor-preferences')
    }
  })

  it('maps every supported label to its exact language code and only Arabic to RTL', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(getChatLanguagePresentation(language.label)).toEqual({
        code: language.code,
        direction: language.code === 'ar' ? 'rtl' : 'ltr',
      })
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
