'use client'

import type { ChangeEvent } from 'react'
import { Globe } from 'lucide-react'

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ar', label: 'العربية' },
]

const STORAGE_KEY = 'pathfinder_language'

export function getStoredLanguage(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(STORAGE_KEY)
}

type LanguagePickerProps = {
  value: string
  onChange: (language: string) => void
  accentColor?: string
}

export function LanguagePicker({ value, onChange, accentColor = '#3A7BD5' }: LanguagePickerProps) {
  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const selected = event.target.value
    localStorage.setItem(STORAGE_KEY, selected)
    onChange(selected)
  }

  return (
    <div className="flex items-center gap-1.5">
      <Globe className="h-3.5 w-3.5 flex-shrink-0 text-pf-deep/40" aria-hidden="true" />
      <select
        value={value}
        onChange={handleChange}
        className="cursor-pointer appearance-none border-none bg-transparent pr-1 text-xs text-pf-deep/60 outline-none transition-colors hover:text-pf-deep focus:text-pf-deep"
        aria-label="Select language"
        style={{ accentColor }}
      >
        {SUPPORTED_LANGUAGES.map((language) => (
          <option key={language.code} value={language.label}>
            {language.label}
          </option>
        ))}
      </select>
    </div>
  )
}
