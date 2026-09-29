'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { SUPPORTED_CHAT_LANGUAGES, type SupportedChatLanguage } from '@pathfinder/api/schemas'

/**
 * Per-device visitor reading preferences. These belong to the visitor's browser only; they are
 * never sent to Torchiko and never mix with the venue's admin theme choices.
 */
export type VisitorTextSize = 'standard' | 'large' | 'larger'
export type VisitorLanguagePreference = 'auto' | SupportedChatLanguage

export type VisitorPreferences = {
  textSize: VisitorTextSize
  language: VisitorLanguagePreference
  highContrast: boolean
}

export const DEFAULT_VISITOR_PREFERENCES: VisitorPreferences = Object.freeze({
  textSize: 'standard',
  language: 'auto',
  highContrast: false,
}) as VisitorPreferences

export const VISITOR_TEXT_SCALE: Record<VisitorTextSize, number> = {
  standard: 1,
  large: 1.15,
  larger: 1.3,
}

const STORAGE_KEY = 'torchiko:visitor-preferences'
/** Written by the former header language picker; only ever held an explicit choice. */
const LEGACY_LANGUAGE_KEY = 'pathfinder_language'
const CHANGE_EVENT = 'torchiko:visitor-preferences-change'
const TEXT_SIZES: readonly VisitorTextSize[] = ['standard', 'large', 'larger']

function isSupportedLanguage(value: unknown): value is SupportedChatLanguage {
  return SUPPORTED_CHAT_LANGUAGES.some((language) => language.label === value)
}

function readRaw(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored !== null) return stored
    const legacy = window.localStorage.getItem(LEGACY_LANGUAGE_KEY)
    return isSupportedLanguage(legacy) ? JSON.stringify({ language: legacy }) : ''
  } catch {
    return ''
  }
}

export function parseVisitorPreferences(raw: string | null | undefined): VisitorPreferences {
  if (!raw) return DEFAULT_VISITOR_PREFERENCES
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof VisitorPreferences, unknown>>
    return {
      textSize: TEXT_SIZES.includes(value.textSize as VisitorTextSize)
        ? (value.textSize as VisitorTextSize)
        : DEFAULT_VISITOR_PREFERENCES.textSize,
      language:
        value.language === 'auto' || isSupportedLanguage(value.language)
          ? value.language
          : DEFAULT_VISITOR_PREFERENCES.language,
      highContrast: value.highContrast === true,
    }
  } catch {
    return DEFAULT_VISITOR_PREFERENCES
  }
}

/** Non-reactive read for code that runs outside React state, such as loading states. */
export function readVisitorPreferences(): VisitorPreferences {
  return typeof window === 'undefined' ? DEFAULT_VISITOR_PREFERENCES : getSnapshot()
}

let cachedRaw: string | null = null
let cachedPreferences: VisitorPreferences = DEFAULT_VISITOR_PREFERENCES
let memoryPreferences: VisitorPreferences | null = null

function getSnapshot(): VisitorPreferences {
  if (memoryPreferences) return memoryPreferences
  const raw = readRaw()
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedPreferences = parseVisitorPreferences(raw)
  }
  return cachedPreferences
}

function getServerSnapshot(): VisitorPreferences {
  return DEFAULT_VISITOR_PREFERENCES
}

function subscribe(onChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) onChange()
  }
  window.addEventListener('storage', handleStorage)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

export function writeVisitorPreferences(next: VisitorPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    memoryPreferences = null
  } catch {
    // Private browsing can deny storage; keep the choice for this page instead.
    memoryPreferences = next
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function useVisitorPreferences(): [
  VisitorPreferences,
  (update: Partial<VisitorPreferences>) => void,
] {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const update = useCallback((change: Partial<VisitorPreferences>) => {
    writeVisitorPreferences({ ...getSnapshot(), ...change })
  }, [])
  return [preferences, update]
}

const noopSubscribe = () => () => undefined

/** False during server render and hydration, true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
}

/** The first supported language the browser reports, or English. */
export function detectBrowserLanguage(
  languages: readonly string[] | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.languages?.length
      ? navigator.languages
      : [navigator.language],
): SupportedChatLanguage {
  for (const tag of languages ?? []) {
    const primary = tag.toLowerCase().split('-')[0]
    const match = SUPPORTED_CHAT_LANGUAGES.find((language) => language.code === primary)
    if (match) return match.label
  }
  return 'English'
}

/**
 * Language for the visitor-facing interface text. With Auto, the guide's reply language is
 * inferred by the server from what the visitor writes; this value only labels the controls.
 */
export function resolveInterfaceLanguage(
  preference: VisitorLanguagePreference,
  hydrated: boolean,
): SupportedChatLanguage {
  if (preference !== 'auto') return preference
  return hydrated ? detectBrowserLanguage() : 'English'
}

/** Only an explicit manual choice is sent to the guide; Auto lets the conversation decide. */
export function requestedReplyLanguage(
  preference: VisitorLanguagePreference,
): SupportedChatLanguage | undefined {
  return preference === 'auto' ? undefined : preference
}
