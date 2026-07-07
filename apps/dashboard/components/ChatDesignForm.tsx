'use client'

import { useRef, useState } from 'react'

import {
  CHAT_FONT_OPTIONS,
  CHAT_THEME_PRESETS,
  type ChatFontValue,
  getChatPalette,
  isHexColor,
} from '@pathfinder/ui'

import { createTRPCClient } from '../lib/trpc'

type Venue = {
  id: string
  name: string
  slug: string
  chatTheme?: string | null
  chatAccentColor?: string | null
  chatFont?: string | null
  chatLogoUrl?: string | null
  chatBannerUrl?: string | null
}

type ChatDesignFormProps = {
  venues: Venue[]
}

type LightThemeValue = (typeof CHAT_THEME_PRESETS)[number]['value']

function isLightThemeValue(value: string | null | undefined): value is LightThemeValue {
  return CHAT_THEME_PRESETS.some((theme) => theme.value === value)
}

function isFontValue(value: string | null | undefined): value is ChatFontValue {
  return CHAT_FONT_OPTIONS.some((font) => font.value === value)
}

function presetAccent(theme: LightThemeValue): string {
  return CHAT_THEME_PRESETS.find((preset) => preset.value === theme)!.accent
}

export function ChatDesignForm({ venues }: ChatDesignFormProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const venue = venues[0]
  const wasDark = venue?.chatTheme === 'dark'
  // The base colour theme is independent of dark mode. If the venue was saved as
  // 'dark', fall back to whichever light preset matches the stored accent (if any)
  // so the preset picker still reflects the underlying hue.
  const initialLightTheme: LightThemeValue =
    isLightThemeValue(venue?.chatTheme) && !wasDark
      ? venue.chatTheme
      : (CHAT_THEME_PRESETS.find((preset) => preset.accent === venue?.chatAccentColor)?.value ??
        'default')

  const [chatTheme, setChatTheme] = useState<LightThemeValue>(initialLightTheme)
  const [darkMode, setDarkMode] = useState(wasDark)
  const [chatAccentColor, setChatAccentColor] = useState(venue?.chatAccentColor ?? '')
  const [chatFont, setChatFont] = useState<ChatFontValue>(
    isFontValue(venue?.chatFont) ? venue.chatFont : 'jakarta',
  )
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const accentOverride = isHexColor(chatAccentColor) ? chatAccentColor : null
  const effectiveTheme = darkMode ? 'dark' : chatTheme
  const palettePreview = getChatPalette(effectiveTheme, accentOverride)

  function toggleDarkMode() {
    setDarkMode((current) => {
      const next = !current
      // Carry the currently selected preset's hue into the neon derivation unless
      // the operator has already typed a custom accent colour.
      if (next && !isHexColor(chatAccentColor)) {
        setChatAccentColor(presetAccent(chatTheme))
      }
      return next
    })
  }

  async function handleSave() {
    if (!venue?.id || isSaving) return
    setSaveError(null)
    setSaved(false)
    setIsSaving(true)

    try {
      await client.venue.updateChatDesign.mutate({
        venueId: venue.id,
        chatTheme: effectiveTheme,
        chatAccentColor: accentOverride,
        chatFont,
      })
      setSaved(true)
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message ? err.message : 'Failed to save. Please try again.'
      setSaveError(message)
    } finally {
      setIsSaving(false)
    }
  }

  if (venues.length === 0) {
    return <p className="text-sm text-pf-deep/50">No venues found. Create a venue first.</p>
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-semibold text-pf-deep">Colour theme</p>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Choose a preset. The custom colour below overrides the accent colour.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {CHAT_THEME_PRESETS.map((theme) => (
            <button
              key={theme.value}
              type="button"
              onClick={() => {
                setChatTheme(theme.value)
              }}
              className={[
                'rounded-2xl border p-4 text-left transition',
                chatTheme === theme.value
                  ? 'border-pf-accent bg-pf-accent/5 ring-2 ring-pf-accent/30'
                  : 'border-pf-light bg-pf-white hover:border-pf-accent/50',
              ].join(' ')}
            >
              <div
                className="h-6 w-6 rounded-full"
                style={{ backgroundColor: theme.accent }}
                aria-hidden="true"
              />
              <p className="mt-2 text-xs font-medium text-pf-deep">{theme.label}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-2xl border border-pf-light bg-pf-white p-4">
        <div className="flex items-center gap-3">
          <div
            className="h-10 w-10 flex-shrink-0 rounded-full border border-pf-light"
            style={{ backgroundColor: darkMode ? palettePreview.bg : '#FFFFFF' }}
            aria-hidden="true"
          >
            <div
              className="m-1.5 h-3 w-3 rounded-full"
              style={{ backgroundColor: palettePreview.accent }}
            />
          </div>
          <div>
            <p className="text-sm font-semibold text-pf-deep">Dark mode (Neon)</p>
            <p className="mt-0.5 text-xs leading-5 text-pf-deep/50">
              Renders the guest chat as a glowing dark palette derived from your accent colour,
              independent of the colour theme above.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={darkMode}
          onClick={toggleDarkMode}
          className={[
            'relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition',
            darkMode ? 'bg-pf-primary' : 'bg-pf-light',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-5 w-5 transform rounded-full bg-white shadow transition',
              darkMode ? 'translate-x-6' : 'translate-x-1',
            ].join(' ')}
          />
        </button>
      </div>

      <div>
        <label className="block text-sm font-semibold text-pf-deep" htmlFor="accent-color">
          Custom accent colour
        </label>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Hex value e.g. <code>#3A7BD5</code>. Overrides the theme accent, and is the colour Dark
          mode derives its neon palette from. Leave blank to use the theme colour.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <input
            id="accent-color"
            type="text"
            placeholder="#3A7BD5"
            value={chatAccentColor}
            maxLength={7}
            onChange={(event) => {
              setChatAccentColor(event.target.value)
            }}
            className="w-40 rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 font-mono text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          />
          <div
            className="h-10 w-10 flex-shrink-0 rounded-full border border-pf-light"
            style={{ backgroundColor: palettePreview.accent }}
            aria-label="Colour preview"
          />
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-pf-deep">Font</p>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Choose the typeface used throughout the guest chat.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {CHAT_FONT_OPTIONS.map((font) => (
            <button
              key={font.value}
              type="button"
              onClick={() => {
                setChatFont(font.value)
              }}
              className={[
                'rounded-2xl border p-4 text-left transition',
                chatFont === font.value
                  ? 'border-pf-accent bg-pf-accent/5 ring-2 ring-pf-accent/30'
                  : 'border-pf-light bg-pf-white hover:border-pf-accent/50',
              ].join(' ')}
            >
              <p className="text-sm text-pf-deep" style={{ fontFamily: `var(${font.cssVar})` }}>
                {font.label}
              </p>
            </button>
          ))}
        </div>
      </div>

      {saveError ? (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          Design saved. Changes will appear in the guest chat immediately.
        </p>
      ) : null}

      <button
        type="button"
        disabled={isSaving || !venue?.id}
        onClick={handleSave}
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-6 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSaving ? 'Saving...' : 'Save design'}
      </button>
    </div>
  )
}
