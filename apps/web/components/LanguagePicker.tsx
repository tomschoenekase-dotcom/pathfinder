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
  English: 'Ask anything about this place...',
  Español: 'Pregunta lo que quieras...',
  Français: 'Posez votre question...',
  Deutsch: 'Frag einfach drauflos...',
  Italiano: 'Chiedi quello che vuoi...',
  Português: 'Pergunte o que quiser...',
  中文: '问点什么吧…',
  日本語: '何でも聞いてください…',
  한국어: '무엇이든 물어보세요...',
  العربية: 'اسأل أي شيء...',
}

export const LANGUAGE_HEADINGS: Record<string, string> = {
  English: 'What can I help you find?',
  Español: '¿En qué te puedo ayudar?',
  Français: 'Que puis-je vous aider à trouver ?',
  Deutsch: 'Wobei kann ich Ihnen helfen?',
  Italiano: 'Come posso aiutarti?',
  Português: 'O que posso ajudá-lo a encontrar?',
  中文: '我能帮您找什么？',
  日本語: '何をお探しですか？',
  한국어: '무엇을 찾아드릴까요?',
  العربية: 'كيف يمكنني مساعدتك في البحث؟',
}

export const LANGUAGE_START_LABELS: Record<string, string> = {
  English: 'Start with a question',
  Español: 'Empieza con una pregunta',
  Français: 'Commencez par une question',
  Deutsch: 'Beginnen Sie mit einer Frage',
  Italiano: 'Inizia con una domanda',
  Português: 'Comece com uma pergunta',
  中文: '从一个问题开始',
  日本語: '質問から始めましょう',
  한국어: '질문으로 시작하세요',
  العربية: 'ابدأ بسؤال',
}

export const LANGUAGE_FALLBACK_DESCRIPTIONS: Record<string, string> = {
  English: 'Ask about exhibits, food, restrooms, directions, or anything nearby.',
  Español: 'Pregunta sobre exposiciones, comida, baños, direcciones o cualquier cosa cercana.',
  Français:
    'Renseignez-vous sur les expositions, la nourriture, les toilettes, les directions ou tout ce qui se trouve à proximité.',
  Deutsch:
    'Fragen Sie nach Ausstellungen, Essen, Toiletten, Wegbeschreibungen oder allem in der Nähe.',
  Italiano: 'Chiedi di mostre, cibo, bagni, indicazioni o qualsiasi cosa nelle vicinanze.',
  Português:
    'Pergunte sobre exposições, comida, banheiros, direções ou qualquer coisa nas proximidades.',
  中文: '询问展览、美食、洗手间、路线或附近的任何事物。',
  日本語: '展示物、食事、トイレ、道案内、または近くのことなど何でもお聞きください。',
  한국어: '전시, 음식, 화장실, 길 안내 또는 근처의 모든 것에 대해 물어보세요.',
  العربية: 'اسأل عن المعارض والطعام والمراحيض والاتجاهات وأي شيء قريب.',
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
    <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--chat-border)] bg-[var(--chat-card)] px-3 py-1.5 shadow-sm">
      <Globe
        className="h-3.5 w-3.5 flex-shrink-0 text-[var(--chat-text-muted)]"
        aria-hidden="true"
      />
      <select
        value={value}
        onChange={handleChange}
        className="cursor-pointer appearance-none border-none bg-transparent text-xs font-medium text-[var(--chat-text-muted)] outline-none transition hover:text-[var(--chat-text)] focus:text-[var(--chat-text)]"
        aria-label="Select language"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.label}>
            {lang.label}
          </option>
        ))}
      </select>
      <svg
        className="h-3 w-3 flex-shrink-0 text-[var(--chat-text-muted)]"
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
