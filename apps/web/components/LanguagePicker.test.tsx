import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getStoredLanguage, LanguagePicker, SUPPORTED_LANGUAGES } from './LanguagePicker'

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
})
