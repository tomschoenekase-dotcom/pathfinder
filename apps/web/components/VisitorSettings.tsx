'use client'

import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { SUPPORTED_CHAT_LANGUAGES, type SupportedChatLanguage } from '@pathfinder/api/schemas'

import styles from './visitor-settings.module.css'
import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorSettingsCopy } from './visitor-settings-copy'
import {
  detectBrowserLanguage,
  type VisitorLanguagePreference,
  type VisitorPreferences,
  type VisitorTextSize,
} from '../lib/visitor-preferences'

const TEXT_SIZES: readonly VisitorTextSize[] = ['standard', 'large', 'larger']
const FOCUSABLE =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export type VisitorSettingsProps = {
  /** Resolved interface language for the labels. */
  language: SupportedChatLanguage
  preferences: VisitorPreferences
  onPreferencesChange: (change: Partial<VisitorPreferences>) => void
  /** Omitted where there is no conversation to clear, such as the venue start screen. */
  onClearChat?: () => void
  clearChatDisabled?: boolean
  clearChatLabel: string
  aboutGuidance: string
  poweredByLabel: string
  attribution: 'link' | 'text' | 'none'
  voiceAvailable?: boolean
  voiceConversationEnabled?: boolean
  onVoiceConversationChange?: (enabled: boolean) => void
}

/**
 * The single small bottom control for visitors: a persistent "AI guide" disclosure and a
 * Settings entry holding reading preferences, Clear chat and "About this guide".
 */
export function VisitorSettings({
  language,
  preferences,
  onPreferencesChange,
  onClearChat,
  clearChatDisabled = false,
  clearChatLabel,
  aboutGuidance,
  poweredByLabel,
  attribution,
  voiceAvailable = false,
  voiceConversationEnabled = true,
  onVoiceConversationChange,
}: VisitorSettingsProps) {
  const copy = getVisitorSettingsCopy(language)
  const presentation = getChatLanguagePresentation(language)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const languageId = useId()
  const languageHintId = useId()
  const contrastHintId = useId()
  const clearHintId = useId()
  const aboutId = useId()
  const voiceHintId = useId()

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus({ preventScroll: true })
    return () => trigger?.focus({ preventScroll: true })
  }, [open])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const detected = detectBrowserLanguage()

  return (
    <>
      <div className={styles.bar} lang={presentation.code} dir={presentation.direction}>
        <span className={styles.disclosure}>{copy.aiGuide}</span>
        <span className={styles.separator} aria-hidden="true" />
        <button
          ref={triggerRef}
          type="button"
          className={styles.trigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {copy.settings}
        </button>
      </div>
      {open ? (
        <div
          className={styles.backdrop}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div
            ref={dialogRef}
            className={styles.sheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            lang={presentation.code}
            dir={presentation.direction}
            onKeyDown={handleKeyDown}
          >
            <div className={styles.sheetHeader}>
              <h2 id={titleId}>{copy.settings}</h2>
              <button
                type="button"
                className={styles.close}
                aria-label={copy.close}
                onClick={() => setOpen(false)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <fieldset className={styles.group}>
              <legend>{copy.textSize}</legend>
              <div className={styles.segments}>
                {TEXT_SIZES.map((size) => (
                  <label key={size} className={styles.segment} data-size={size}>
                    <input
                      type="radio"
                      name={`${titleId}-text-size`}
                      value={size}
                      checked={preferences.textSize === size}
                      onChange={() => onPreferencesChange({ textSize: size })}
                    />
                    <span>{copy[size]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className={styles.group}>
              <label htmlFor={languageId} className={styles.label}>
                {copy.language}
              </label>
              <select
                id={languageId}
                className={styles.select}
                value={preferences.language}
                aria-describedby={preferences.language === 'auto' ? languageHintId : undefined}
                onChange={(event) =>
                  onPreferencesChange({
                    language: event.target.value as VisitorLanguagePreference,
                  })
                }
              >
                <option value="auto">
                  {copy.automatic} ({detected})
                </option>
                {SUPPORTED_CHAT_LANGUAGES.map((option) => {
                  const optionPresentation = getChatLanguagePresentation(option.label)
                  return (
                    <option
                      key={option.code}
                      value={option.label}
                      lang={optionPresentation.code}
                      dir={optionPresentation.direction}
                    >
                      {option.label}
                    </option>
                  )
                })}
              </select>
              {preferences.language === 'auto' ? (
                <p id={languageHintId} className={styles.hint}>
                  {copy.automaticHint}
                </p>
              ) : null}
            </div>

            <label className={`${styles.group} ${styles.switchRow}`}>
              <span>
                <span className={styles.label}>{copy.highContrast}</span>
                <span id={contrastHintId} className={styles.hint}>
                  {copy.highContrastHint}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className={styles.switch}
                checked={preferences.highContrast}
                aria-describedby={contrastHintId}
                onChange={(event) => onPreferencesChange({ highContrast: event.target.checked })}
              />
            </label>

            {voiceAvailable ? (
              <label className={`${styles.group} ${styles.switchRow}`}>
                <span>
                  <span className={styles.label}>Voice conversation</span>
                  <span id={voiceHintId} className={styles.hint}>
                    Use your microphone for a spoken conversation. Text chat stays available.
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className={styles.switch}
                  checked={voiceConversationEnabled}
                  aria-label="Voice conversation"
                  aria-describedby={voiceHintId}
                  onChange={(event) => onVoiceConversationChange?.(event.target.checked)}
                />
              </label>
            ) : null}

            {onClearChat ? (
              <div className={styles.group}>
                <button
                  type="button"
                  className={styles.clear}
                  disabled={clearChatDisabled}
                  aria-describedby={clearHintId}
                  onClick={() => {
                    setOpen(false)
                    // Let focus return to Settings before the confirmation records it.
                    window.setTimeout(onClearChat, 0)
                  }}
                >
                  {clearChatLabel}
                </button>
                <p id={clearHintId} className={styles.hint}>
                  {copy.clearChatHint}
                </p>
              </div>
            ) : null}

            <section className={styles.about} aria-labelledby={aboutId}>
              <h3 id={aboutId}>{copy.about}</h3>
              <p role="note">{aboutGuidance}</p>
              {attribution !== 'none' ? (
                <p className={styles.attribution} lang="en" dir="ltr">
                  <span lang={presentation.code} dir={presentation.direction}>
                    {poweredByLabel}
                  </span>{' '}
                  {attribution === 'link' ? (
                    <a href="https://torchiko.com">Torchiko</a>
                  ) : (
                    <span>Torchiko</span>
                  )}
                </p>
              ) : null}
            </section>
          </div>
        </div>
      ) : null}
    </>
  )
}
