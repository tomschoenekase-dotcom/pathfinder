'use client'

import { useMemo, useRef, useState } from 'react'

import { createTRPCClient } from '../lib/trpc'

type Venue = {
  id: string
  name: string
  slug: string
  chatTheme?: string | null
  chatAccentColor?: string | null
  chatLogoUrl?: string | null
  chatBannerUrl?: string | null
}

type ChatDesignFormProps = {
  venues: Venue[]
}

const THEMES = [
  { value: 'default', label: 'PathFinder Blue', accent: '#3A7BD5', surface: '#F2F5F9' },
  { value: 'forest', label: 'Forest', accent: '#2D6A4F', surface: '#F0F7F4' },
  { value: 'sunset', label: 'Sunset', accent: '#E07B39', surface: '#FBF4EF' },
  { value: 'midnight', label: 'Midnight', accent: '#4361EE', surface: '#EEF0F8' },
  { value: 'rose', label: 'Rose', accent: '#D4607A', surface: '#FDF0F3' },
] as const

type ThemeValue = (typeof THEMES)[number]['value']

function isThemeValue(value: string | null | undefined): value is ThemeValue {
  return THEMES.some((theme) => theme.value === value)
}

function isHexColor(value: string) {
  return /^#[0-9A-Fa-f]{6}$/.test(value)
}

export function ChatDesignForm({ venues }: ChatDesignFormProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [selectedVenueId, setSelectedVenueId] = useState(venues[0]?.id ?? '')
  const selectedVenue = useMemo(
    () => venues.find((venue) => venue.id === selectedVenueId) ?? venues[0],
    [selectedVenueId, venues],
  )
  const [chatTheme, setChatTheme] = useState<ThemeValue>(
    isThemeValue(selectedVenue?.chatTheme) ? selectedVenue.chatTheme : 'default',
  )
  const [chatAccentColor, setChatAccentColor] = useState(selectedVenue?.chatAccentColor ?? '')
  const [chatLogoUrl, setChatLogoUrl] = useState(selectedVenue?.chatLogoUrl ?? '')
  const [chatBannerUrl, setChatBannerUrl] = useState(selectedVenue?.chatBannerUrl ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const previewAccent = isHexColor(chatAccentColor)
    ? chatAccentColor
    : (THEMES.find((theme) => theme.value === chatTheme)?.accent ?? '#3A7BD5')

  function handleVenueChange(venueId: string) {
    const nextVenue = venues.find((venue) => venue.id === venueId)
    setSelectedVenueId(venueId)
    setChatTheme(isThemeValue(nextVenue?.chatTheme) ? nextVenue.chatTheme : 'default')
    setChatAccentColor(nextVenue?.chatAccentColor ?? '')
    setChatLogoUrl(nextVenue?.chatLogoUrl ?? '')
    setChatBannerUrl(nextVenue?.chatBannerUrl ?? '')
    setSaveError(null)
    setSaved(false)
  }

  async function handleSave() {
    if (!selectedVenueId || isSaving) return
    setSaveError(null)
    setSaved(false)
    setIsSaving(true)

    try {
      await client.venue.updateChatDesign.mutate({
        venueId: selectedVenueId,
        chatTheme,
        chatAccentColor: isHexColor(chatAccentColor) ? chatAccentColor : null,
        chatLogoUrl: chatLogoUrl.trim() || null,
        chatBannerUrl: chatBannerUrl.trim() || null,
      })
      setSaved(true)
    } catch {
      setSaveError('Failed to save. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  if (venues.length === 0) {
    return <p className="text-sm text-pf-deep/50">No venues found. Create a venue first.</p>
  }

  return (
    <div className="space-y-8">
      {venues.length > 1 && (
        <div>
          <label className="block text-sm font-semibold text-pf-deep" htmlFor="design-venue">
            Venue
          </label>
          <select
            id="design-venue"
            value={selectedVenueId}
            onChange={(event) => {
              handleVenueChange(event.target.value)
            }}
            className="mt-2 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          >
            {venues.map((venue) => (
              <option key={venue.id} value={venue.id}>
                {venue.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <p className="text-sm font-semibold text-pf-deep">Colour theme</p>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Choose a preset. The custom colour below overrides the accent colour.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {THEMES.map((theme) => (
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
        <label className="block text-sm font-semibold text-pf-deep" htmlFor="chat-logo-url">
          Your logo URL
        </label>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Link to your logo image. Square PNG or SVG files work best.
        </p>
        <input
          id="chat-logo-url"
          type="url"
          placeholder="https://yoursite.com/logo.png"
          value={chatLogoUrl}
          onChange={(event) => {
            setChatLogoUrl(event.target.value)
          }}
          className="mt-3 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none transition placeholder:text-pf-deep/30 focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
        {chatLogoUrl ? (
          <div className="mt-3 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={chatLogoUrl}
              alt="Logo preview"
              className="h-10 w-10 rounded-xl border border-pf-light object-contain"
              onError={(event) => {
                ;(event.target as HTMLImageElement).style.display = 'none'
              }}
            />
            <p className="text-xs text-pf-deep/50">Preview</p>
          </div>
        ) : null}
      </div>

      <div>
        <label className="block text-sm font-semibold text-pf-deep" htmlFor="chat-banner-url">
          Chat header background image URL
        </label>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Optional banner image shown behind the venue name in the chat header.
        </p>
        <input
          id="chat-banner-url"
          type="url"
          placeholder="https://yoursite.com/banner.jpg"
          value={chatBannerUrl}
          onChange={(event) => {
            setChatBannerUrl(event.target.value)
          }}
          className="mt-3 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none transition placeholder:text-pf-deep/30 focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
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
        disabled={isSaving || !selectedVenueId}
        onClick={handleSave}
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-6 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSaving ? 'Saving...' : 'Save design'}
      </button>
    </div>
  )
}
