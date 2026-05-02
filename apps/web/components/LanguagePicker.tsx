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

export const LANGUAGE_PLACEHOLDERS: Record<string, string> = {
  English: 'Ask what is nearby, where to go next, or where to find amenities.',
  Español: 'Pregunta qué hay cerca, a dónde ir o dónde encontrar servicios.',
  Français: 'Demandez ce qui est proche, où aller ou où trouver des équipements.',
  Deutsch: 'Fragen Sie, was in der Nähe ist, wohin Sie gehen oder wo Sie Einrichtungen finden.',
  Italiano: "Chiedi cosa c'è nelle vicinanze, dove andare o dove trovare i servizi.",
  Português: 'Pergunte o que há por perto, para onde ir ou onde encontrar comodidades.',
  中文: '询问附近有什么、下一步去哪里或在哪里可以找到设施。',
  日本語: '近くに何があるか、次にどこへ行くか、設備はどこにあるかを聞いてください。',
  한국어: '주변에 무엇이 있는지, 다음에 어디로 갈지, 편의시설은 어디에 있는지 물어보세요.',
  العربية: 'اسأل عما هو قريب منك، وأين تذهب، وأين تجد المرافق.',
}

const STORAGE_KEY = 'pathfinder_language'

export function getStoredLanguage(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(STORAGE_KEY)
}

type LanguagePickerProps = {
  value: string
  onChange: (language: string) => void
}

export function LanguagePicker({ value, onChange }: LanguagePickerProps) {
  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const selected = event.target.value
    localStorage.setItem(STORAGE_KEY, selected)
    onChange(selected)
  }

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-pf-light bg-pf-white px-3 py-1.5 shadow-sm">
      <Globe className="h-3.5 w-3.5 flex-shrink-0 text-pf-deep/50" aria-hidden="true" />
      <select
        value={value}
        onChange={handleChange}
        className="cursor-pointer appearance-none border-none bg-transparent text-xs font-medium text-pf-deep/70 outline-none transition hover:text-pf-deep focus:text-pf-deep"
        aria-label="Select language"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.label}>
            {lang.label}
          </option>
        ))}
      </select>
      <svg
        className="h-3 w-3 flex-shrink-0 text-pf-deep/40"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
          clipRule="evenodd"
        />
      </svg>
    </div>
  )
}
