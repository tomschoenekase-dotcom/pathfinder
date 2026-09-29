/* @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_VISITOR_PREFERENCES,
  detectBrowserLanguage,
  parseVisitorPreferences,
  requestedReplyLanguage,
  resolveInterfaceLanguage,
  useVisitorPreferences,
} from './visitor-preferences'

describe('visitor preferences', () => {
  afterEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults to Auto language, standard text and normal contrast', () => {
    expect(DEFAULT_VISITOR_PREFERENCES).toEqual({
      textSize: 'standard',
      language: 'auto',
      highContrast: false,
    })
    expect(parseVisitorPreferences('not json')).toEqual(DEFAULT_VISITOR_PREFERENCES)
    expect(
      parseVisitorPreferences(
        JSON.stringify({ textSize: 'huge', language: 'Klingon', highContrast: 'yes' }),
      ),
    ).toEqual(DEFAULT_VISITOR_PREFERENCES)
  })

  it('treats a choice from the former header picker as a manual override', () => {
    window.localStorage.setItem('pathfinder_language', 'Deutsch')
    const { result } = renderHook(() => useVisitorPreferences())
    expect(result.current[0].language).toBe('Deutsch')
  })

  it('persists changes for this browser and shares them with other mounted screens', () => {
    const first = renderHook(() => useVisitorPreferences())
    const second = renderHook(() => useVisitorPreferences())
    act(() => first.result.current[1]({ textSize: 'larger', highContrast: true }))
    expect(second.result.current[0]).toEqual({
      textSize: 'larger',
      language: 'auto',
      highContrast: true,
    })
    expect(JSON.parse(window.localStorage.getItem('torchiko:visitor-preferences')!)).toEqual(
      second.result.current[0],
    )
  })

  it('keeps a change for the page when storage is denied', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })
    const { result } = renderHook(() => useVisitorPreferences())
    act(() => result.current[1]({ language: '한국어' }))
    expect(result.current[0].language).toBe('한국어')
  })

  it('sends only an explicit language to the guide and labels Auto from the browser', () => {
    expect(requestedReplyLanguage('auto')).toBeUndefined()
    expect(requestedReplyLanguage('English')).toBe('English')
    expect(detectBrowserLanguage(['pt-BR', 'en-US'])).toBe('Português')
    expect(detectBrowserLanguage(['zh-Hant-TW'])).toBe('中文')
    expect(detectBrowserLanguage(['sv-SE'])).toBe('English')
    expect(resolveInterfaceLanguage('auto', false)).toBe('English')
    expect(resolveInterfaceLanguage('العربية', false)).toBe('العربية')
  })
})
