'use client'

import { useRef, useState } from 'react'

import {
  CHAT_FONT_OPTIONS,
  CHAT_THEME_PRESETS,
  type ChatFontValue,
  type ChatThemeValue,
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

const THEMES: { value: ChatThemeValue; label: string; accent: string }[] = [
  ...CHAT_THEME_PRESETS.map((preset) => ({
    value: preset.value as ChatThemeValue,
    label: preset.label,
    accent: preset.accent,
  })),
  { value: 'dark', label: 'Dark (Neon)', accent: '#3A7BD5' },
]

function isThemeValue(value: string | null | undefined): value is ChatThemeValue {
  return THEMES.some((theme) => theme.value === value)
}

function isFontValue(value: string | null | undefined): value is ChatFontValue {
  return CHAT_FONT_OPTIONS.some((font) => font.value === value)
}

export function ChatDesignForm({ venues }: ChatDesignFormProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const venue = venues[0]
  const [chatTheme, setChatTheme] = useState<ChatThemeValue>(
    isThemeValue(venue?.chatTheme) ? venue.chatTheme : 'default',
  )
  const [chatAccentColor, setChatAccentColor] = useState(venue?.chatAccentColor ?? '')
  const [chatFont, setChatFont] = useState<ChatFontValue>(
    isFontValue(venue?.chatFont) ? venue.chatFont : 'jakarta',
  )
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const accentOverride = isHexColor(chatAccentColor) ? chatAccentColor : null
  const previewAccent = getChatPalette(chatTheme, accentOverride).accent

  async function handleSave() {
    if (!venue?.id || isSaving) return
    setSaveError(null)
    setSaved(false)
    setIsSaving(true)

    try {
      await client.venue.updateChatDesign.mutate({
        venueId: venue.id,
        chatTheme,
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
          Choose a preset. The custom colour below overrides the accent colour. Dark (Neon) derives
          a glowing dark palette from your accent colour automatically.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {THEMES.map((theme) => {
            const swatchColor = getChatPalette(theme.value, accentOverride).accent
            return (
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
                  style={{ backgroundColor: swatchColor }}
                  aria-hidden="true"
                />
                <p className="mt-2 text-xs font-medium text-pf-deep">{theme.label}</p>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-pf-deep" htmlFor="accent-color">
          Custom accent colour
        </label>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Hex value e.g. <code>#3A7BD5</code>. Overrides the theme accent. Leave blank to use the
          theme colour.
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
            style={{ backgroundColor: previewAccent }}
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
