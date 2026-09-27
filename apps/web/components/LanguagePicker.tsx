'use client'

import { SUPPORTED_CHAT_LANGUAGES } from '@pathfinder/api/schemas'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

import { detectBrowserLanguage, readVisitorPreferences } from '../lib/visitor-preferences'

export const SUPPORTED_LANGUAGES = SUPPORTED_CHAT_LANGUAGES
const RTL_CHAT_LANGUAGE_CODES: ReadonlySet<string> = new Set(['ar'])

export type ChatTextDirection = 'ltr' | 'rtl'

export type ChatLanguagePresentation = {
  code: (typeof SUPPORTED_LANGUAGES)[number]['code']
  direction: ChatTextDirection
}

export function getChatLanguagePresentation(
  language: SupportedChatLanguage,
): ChatLanguagePresentation {
  const supported = SUPPORTED_LANGUAGES.find((candidate) => candidate.label === language)

  // SupportedChatLanguage and SUPPORTED_LANGUAGES share one server-owned contract. Keep the
  // fallback fail-readable in case a stale client bundle ever receives a newer stored label.
  if (!supported) return { code: 'en', direction: 'ltr' }

  return {
    code: supported.code,
    direction: RTL_CHAT_LANGUAGE_CODES.has(supported.code) ? 'rtl' : 'ltr',
  }
}

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

/**
 * Interface language to show before the chat hydrates: the visitor's manual choice from
 * Settings, otherwise the browser language (the Auto default).
 */
export function getStoredLanguage(): SupportedChatLanguage | null {
  if (typeof window === 'undefined') return null
  const preferences = readVisitorPreferences()
  return preferences.language === 'auto' ? detectBrowserLanguage() : preferences.language
}
