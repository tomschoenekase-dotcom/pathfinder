'use client'

import { useEffect, useRef, useState } from 'react'

import {
  CHAT_FONT_OPTIONS,
  CHAT_THEME_PRESETS,
  type ChatFontValue,
  getChatPalette,
  isHexColor,
} from '@pathfinder/ui'

import { useTRPCClient } from '../lib/trpc'
import { runBoundedClientRequest } from '../lib/bounded-client-request'

type Venue = {
  id: string
  name: string
  slug: string
  chatTheme?: string | null
  chatAccentColor?: string | null
  chatFont?: string | null
  chatLogoUrl?: string | null
  chatBannerUrl?: string | null
  chatLogoDerivativeId?: string | null
  chatBannerDerivativeId?: string | null
  chatShowPhotos?: boolean
  chatShowLinks?: boolean
  updatedAt: string | Date
}

type ChatDesignFormProps = {
  venues: Venue[]
  brandingAssetsByVenue?: Record<string, BrandingAssetPage>
  previewOrigin?: string
  visitorUrlsByVenue?: Record<string, string | null>
  canEdit?: boolean
  initialVenueId?: string
  updateDesign?: (input: {
    venueId: string
    expectedUpdatedAt: Date
    chatTheme: (typeof CHAT_THEME_PRESETS)[number]['value'] | 'dark'
    chatAccentColor: string | null
    chatFont: ChatFontValue
    chatLogoUrl?: string | null
    chatBannerUrl?: string | null
    chatLogoDerivativeId?: string | null
    chatBannerDerivativeId?: string | null
    chatLogoDerivativeReceipt?: BrandingDerivativeReceipt | null
    chatBannerDerivativeReceipt?: BrandingDerivativeReceipt | null
    chatShowPhotos: boolean
    chatShowLinks: boolean
  }) => Promise<SavedChatDesign>
}

type BrandingAsset = {
  derivativeId: string
  assetId: string
  altText: string
  caption: string | null
  deliveryPath: string
  sourceObjectGeneration?: string
  sha256?: string | null
  approvedReviewSequence?: number
}

type BrandingAssetPage = {
  items: readonly BrandingAsset[]
  nextCursor: string | null
}

type BrandingDerivativeReceipt = {
  assetId: string
  derivativeId: string
  sourceObjectGeneration: string
  sha256: string
  approvedReviewSequence: number
}

function toReceipt(asset: BrandingAsset | undefined): BrandingDerivativeReceipt | null {
  if (!asset) return null
  if (!asset.sourceObjectGeneration || !asset.sha256 || !asset.approvedReviewSequence) return null
  return {
    assetId: asset.assetId,
    derivativeId: asset.derivativeId,
    sourceObjectGeneration: asset.sourceObjectGeneration,
    sha256: asset.sha256,
    approvedReviewSequence: asset.approvedReviewSequence,
  }
}

type SavedChatDesign = {
  chatTheme?: string | null
  chatAccentColor?: string | null
  chatFont?: string | null
  hasLogo?: boolean
  hasBanner?: boolean
  chatLogoDerivativeId?: string | null
  chatBannerDerivativeId?: string | null
  chatShowPhotos?: boolean
  chatShowLinks?: boolean
  updatedAt: Date
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

function buildAppearancePreviewUrl(
  origin: string | undefined,
  theme: LightThemeValue | 'dark',
  font: ChatFontValue,
  accent: string | null,
): string | null {
  if (!origin) return null
  try {
    const url = new URL('/appearance-preview', origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.searchParams.set('theme', theme)
    url.searchParams.set('font', font)
    if (accent) url.searchParams.set('accent', accent)
    return url.toString()
  } catch {
    return null
  }
}

function designStateForVenue(venue: Venue | undefined) {
  const darkMode = venue?.chatTheme === 'dark'
  const chatTheme: LightThemeValue =
    isLightThemeValue(venue?.chatTheme) && !darkMode
      ? venue.chatTheme
      : (CHAT_THEME_PRESETS.find((preset) => preset.accent === venue?.chatAccentColor)?.value ??
        'default')

  return {
    chatTheme,
    darkMode,
    chatAccentColor: venue?.chatAccentColor ?? '',
    chatFont: isFontValue(venue?.chatFont) ? venue.chatFont : ('jakarta' as const),
    chatLogoUrl: venue?.chatLogoUrl ?? null,
    chatBannerUrl: venue?.chatBannerUrl ?? null,
    chatLogoDerivativeId: venue?.chatLogoDerivativeId ?? null,
    chatBannerDerivativeId: venue?.chatBannerDerivativeId ?? null,
    chatShowPhotos: venue?.chatShowPhotos ?? false,
    chatShowLinks: venue?.chatShowLinks ?? false,
  }
}

export function ChatDesignForm({
  venues,
  brandingAssetsByVenue = {},
  previewOrigin,
  visitorUrlsByVenue = {},
  canEdit = true,
  initialVenueId,
  updateDesign,
}: ChatDesignFormProps) {
  const client = useTRPCClient()
  const queryScope = useRef(new AbortController())
  const revisions = useRef(
    new Map(venues.map((candidate) => [candidate.id, new Date(candidate.updatedAt)])),
  )
  const savedDesigns = useRef(
    new Map(venues.map((candidate) => [candidate.id, designStateForVenue(candidate)])),
  )

  const [selectedVenueId, setSelectedVenueId] = useState(
    initialVenueId && venues.some((candidate) => candidate.id === initialVenueId)
      ? initialVenueId
      : (venues[0]?.id ?? ''),
  )
  const venue = venues.find((candidate) => candidate.id === selectedVenueId)
  const [brandingPages, setBrandingPages] = useState(brandingAssetsByVenue)
  const brandingPage = brandingPages[selectedVenueId] ?? { items: [], nextCursor: null }
  const brandingAssets = brandingPage.items
  const initialDesign = designStateForVenue(venue)
  const [chatTheme, setChatTheme] = useState<LightThemeValue>(initialDesign.chatTheme)
  const [darkMode, setDarkMode] = useState(initialDesign.darkMode)
  const [chatAccentColor, setChatAccentColor] = useState(initialDesign.chatAccentColor)
  const [chatFont, setChatFont] = useState<ChatFontValue>(initialDesign.chatFont)
  const [chatLogoUrl, setChatLogoUrl] = useState(initialDesign.chatLogoUrl)
  const [chatBannerUrl, setChatBannerUrl] = useState(initialDesign.chatBannerUrl)
  const [chatLogoDerivativeId, setChatLogoDerivativeId] = useState(
    initialDesign.chatLogoDerivativeId ?? null,
  )
  const [chatBannerDerivativeId, setChatBannerDerivativeId] = useState(
    initialDesign.chatBannerDerivativeId ?? null,
  )
  const [chatShowPhotos, setChatShowPhotos] = useState(initialDesign.chatShowPhotos)
  const [chatShowLinks, setChatShowLinks] = useState(initialDesign.chatShowLinks)
  const [savedDesign, setSavedDesign] = useState(initialDesign)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [isLoadingAssets, setIsLoadingAssets] = useState(false)
  useEffect(() => {
    if (queryScope.current.signal.aborted) queryScope.current = new AbortController()
    const controller = queryScope.current
    setIsLoadingAssets(false)
    setAssetLoadError(null)
    return () => controller.abort()
  }, [client, selectedVenueId])
  const [assetLoadError, setAssetLoadError] = useState<string | null>(null)
  const mutationInFlight = useRef(false)

  const normalizedAccent = chatAccentColor.trim()
  const invalidAccent = normalizedAccent !== '' && !isHexColor(normalizedAccent)
  const accentOverride = isHexColor(normalizedAccent) ? normalizedAccent : null
  const effectiveTheme: LightThemeValue | 'dark' = darkMode ? 'dark' : chatTheme
  const palettePreview = getChatPalette(effectiveTheme, accentOverride)
  const appearancePreviewUrl = buildAppearancePreviewUrl(
    previewOrigin,
    effectiveTheme,
    chatFont,
    accentOverride,
  )
  const isDirty =
    chatTheme !== savedDesign.chatTheme ||
    darkMode !== savedDesign.darkMode ||
    chatAccentColor !== savedDesign.chatAccentColor ||
    chatFont !== savedDesign.chatFont ||
    chatLogoUrl !== savedDesign.chatLogoUrl ||
    chatBannerUrl !== savedDesign.chatBannerUrl ||
    chatLogoDerivativeId !== (savedDesign.chatLogoDerivativeId ?? null) ||
    chatBannerDerivativeId !== (savedDesign.chatBannerDerivativeId ?? null) ||
    chatShowPhotos !== savedDesign.chatShowPhotos ||
    chatShowLinks !== savedDesign.chatShowLinks

  function markDirty() {
    setSaveError(null)
    setSaved(false)
  }

  function toggleDarkMode() {
    markDirty()
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

  function selectVenue(venueId: string) {
    if (mutationInFlight.current) return
    const nextVenue = venues.find((candidate) => candidate.id === venueId)
    if (!nextVenue || nextVenue.id === venue?.id) return
    if (isDirty && !window.confirm('Switch venues? Unsaved design changes will be discarded.')) {
      return
    }

    const next = savedDesigns.current.get(nextVenue.id) ?? designStateForVenue(nextVenue)
    setSelectedVenueId(nextVenue.id)
    setChatTheme(next.chatTheme)
    setDarkMode(next.darkMode)
    setChatAccentColor(next.chatAccentColor)
    setChatFont(next.chatFont)
    setChatLogoUrl(next.chatLogoUrl)
    setChatBannerUrl(next.chatBannerUrl)
    setChatLogoDerivativeId(next.chatLogoDerivativeId ?? null)
    setChatBannerDerivativeId(next.chatBannerDerivativeId ?? null)
    setChatShowPhotos(next.chatShowPhotos)
    setChatShowLinks(next.chatShowLinks)
    setSavedDesign(next)
    setSaveError(null)
    setSaved(false)
    setAssetLoadError(null)
  }

  async function loadMoreAssets() {
    if (!venue?.id || !brandingPage.nextCursor || isLoadingAssets) return
    const cursor = brandingPage.nextCursor
    const controller = queryScope.current
    const initiatingClient = client
    const initiatingVenueId = venue.id
    setIsLoadingAssets(true)
    setAssetLoadError(null)
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: 15_000,
        request: (signal) =>
          client.venue.listApprovedBrandingAssets.query(
            {
              venueId: venue.id,
              cursor,
            },
            { signal },
          ),
      })
      if (
        controller.signal.aborted ||
        queryScope.current !== controller ||
        client !== initiatingClient ||
        venue.id !== initiatingVenueId
      )
        return
      setBrandingPages((current) => {
        const page = current[venue.id] ?? { items: [], nextCursor: null }
        const seen = new Set(page.items.map((asset) => asset.derivativeId))
        return {
          ...current,
          [venue.id]: {
            items: [...page.items, ...next.items.filter((asset) => !seen.has(asset.derivativeId))],
            nextCursor: next.nextCursor,
          },
        }
      })
    } catch (error) {
      if (
        controller.signal.aborted ||
        queryScope.current !== controller ||
        client !== initiatingClient ||
        venue.id !== initiatingVenueId
      )
        return
      setAssetLoadError(
        error instanceof Error ? error.message : 'More reviewed assets could not be loaded.',
      )
    } finally {
      if (
        !controller.signal.aborted &&
        queryScope.current === controller &&
        client === initiatingClient &&
        venue.id === initiatingVenueId
      )
        setIsLoadingAssets(false)
    }
  }

  async function handleSave() {
    if (!canEdit || !venue?.id || mutationInFlight.current) return
    if (invalidAccent) {
      setSaved(false)
      setSaveError('Enter a six-digit hex colour such as #3A7BD5, or leave it blank.')
      return
    }

    mutationInFlight.current = true
    setSaveError(null)
    setSaved(false)
    setIsSaving(true)

    try {
      const selectedLogoReceipt = toReceipt(
        brandingAssets.find((asset) => asset.derivativeId === chatLogoDerivativeId)!,
      )
      const selectedBannerReceipt = toReceipt(
        brandingAssets.find((asset) => asset.derivativeId === chatBannerDerivativeId)!,
      )
      const saveInput = {
        venueId: venue.id,
        expectedUpdatedAt: revisions.current.get(venue.id) ?? new Date(venue.updatedAt),
        chatTheme: effectiveTheme,
        chatAccentColor: accentOverride,
        chatFont,
        chatShowPhotos,
        chatShowLinks,
        ...(venue.chatLogoUrl !== undefined ? { chatLogoUrl } : {}),
        ...(venue.chatBannerUrl !== undefined ? { chatBannerUrl } : {}),
        ...(venue.chatLogoDerivativeId !== undefined &&
        chatLogoDerivativeId !== (savedDesign.chatLogoDerivativeId ?? null)
          ? { chatLogoDerivativeId, chatLogoDerivativeReceipt: selectedLogoReceipt }
          : {}),
        ...(venue.chatBannerDerivativeId !== undefined &&
        chatBannerDerivativeId !== (savedDesign.chatBannerDerivativeId ?? null)
          ? { chatBannerDerivativeId, chatBannerDerivativeReceipt: selectedBannerReceipt }
          : {}),
      }
      const saved = updateDesign
        ? await updateDesign(saveInput)
        : ((await client.venue.updateChatDesign.mutate(saveInput)) as SavedChatDesign)
      revisions.current.set(venue.id, saved.updatedAt)
      const savedTheme =
        saved.chatTheme === 'dark'
          ? chatTheme
          : isLightThemeValue(saved.chatTheme)
            ? saved.chatTheme
            : chatTheme
      const savedDarkMode = saved.chatTheme ? saved.chatTheme === 'dark' : darkMode
      // A canonical null means the override was cleared, not that the response omitted it.
      const savedAccentColor =
        saved.chatAccentColor !== undefined ? (saved.chatAccentColor ?? '') : (accentOverride ?? '')
      const savedFont = isFontValue(saved.chatFont) ? saved.chatFont : chatFont
      const savedLogoUrl = saved.hasLogo === false ? null : chatLogoUrl
      const savedBannerUrl = saved.hasBanner === false ? null : chatBannerUrl
      setChatTheme(savedTheme)
      setDarkMode(savedDarkMode)
      setChatAccentColor(savedAccentColor)
      setChatFont(savedFont)
      setChatLogoUrl(savedLogoUrl)
      setChatBannerUrl(savedBannerUrl)
      const savedLogoDerivativeId =
        saved.chatLogoDerivativeId !== undefined ? saved.chatLogoDerivativeId : chatLogoDerivativeId
      const savedBannerDerivativeId =
        saved.chatBannerDerivativeId !== undefined
          ? saved.chatBannerDerivativeId
          : chatBannerDerivativeId
      setChatLogoDerivativeId(savedLogoDerivativeId)
      setChatBannerDerivativeId(savedBannerDerivativeId)
      const savedShowPhotos = saved.chatShowPhotos ?? chatShowPhotos
      const savedShowLinks = saved.chatShowLinks ?? chatShowLinks
      setChatShowPhotos(savedShowPhotos)
      setChatShowLinks(savedShowLinks)
      const canonicalDesign = {
        chatTheme: savedTheme,
        darkMode: savedDarkMode,
        chatAccentColor: savedAccentColor,
        chatFont: savedFont,
        chatLogoUrl: savedLogoUrl,
        chatBannerUrl: savedBannerUrl,
        chatLogoDerivativeId: savedLogoDerivativeId,
        chatBannerDerivativeId: savedBannerDerivativeId,
        chatShowPhotos: savedShowPhotos,
        chatShowLinks: savedShowLinks,
      }
      savedDesigns.current.set(venue.id, canonicalDesign)
      setSavedDesign(canonicalDesign)
      setSaved(true)
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message ? err.message : 'Failed to save. Please try again.'
      setSaveError(message)
    } finally {
      mutationInFlight.current = false
      setIsSaving(false)
    }
  }

  if (venues.length === 0) {
    return <p className="text-sm text-pf-deep/70">No venues found. Create a venue first.</p>
  }

  return (
    <div className="space-y-8">
      <div>
        <label className="block text-sm font-semibold text-pf-deep" htmlFor="chat-design-venue">
          Venue
        </label>
        <select
          id="chat-design-venue"
          value={selectedVenueId}
          disabled={isSaving}
          onChange={(event) => selectVenue(event.target.value)}
          className="mt-3 min-h-11 w-full rounded-2xl border border-pf-light bg-pf-white px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {venues.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <section aria-label="Appearance preview" className="rounded-2xl border border-pf-light p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-sm font-semibold text-pf-deep">Appearance preview</h2>
          <p className="text-xs text-pf-deep/70" aria-live="polite">
            {isDirty
              ? 'Unsaved changes · Save design to keep this appearance.'
              : 'Showing the saved appearance.'}
          </p>
        </div>
        <p className="mt-1 text-xs leading-5 text-pf-deep/70">
          Opens a fixed sample conversation in the visitor renderer. The preview does not send a
          message or change venue data.
        </p>
        {invalidAccent ? (
          <p className="mt-2 text-xs font-medium text-amber-800" role="note">
            Enter a valid six-digit hex colour to preview your custom accent. The preview currently
            uses the selected theme colour.
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-3">
          {appearancePreviewUrl ? (
            <a
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-primary px-4 text-sm font-semibold text-pf-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              href={appearancePreviewUrl}
              target="_blank"
              rel="noreferrer"
            >
              {isDirty ? 'Preview unsaved appearance' : 'Preview appearance'}
            </a>
          ) : (
            <p className="text-sm text-pf-deep/70">
              Appearance preview is unavailable from this client session.
            </p>
          )}
          {saved && !isDirty && venue?.id && visitorUrlsByVenue[venue.id] ? (
            <a
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-4 text-sm font-semibold text-white hover:bg-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              href={visitorUrlsByVenue[venue.id] ?? undefined}
              target="_blank"
              rel="noreferrer"
            >
              Open saved visitor guide
            </a>
          ) : null}
        </div>
        {saved && !isDirty && venue?.id && visitorUrlsByVenue[venue.id] ? (
          <p className="mt-2 text-xs leading-5 text-pf-deep/70">
            The saved visitor guide reads this venue&apos;s persisted appearance. Reload it to check
            the update.
          </p>
        ) : null}
      </section>

      <div className="rounded-2xl border border-pf-light bg-pf-white p-4">
        <p className="text-sm font-semibold text-pf-deep">Reviewed branding assets</p>
        <p className="mt-1 text-xs leading-5 text-pf-deep/70">
          Only assets already reviewed for this venue can be retained. This editor cannot upload or
          accept arbitrary URLs.
        </p>
        {chatLogoUrl ? (
          <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-pf-deep">
            <input
              type="checkbox"
              checked={Boolean(chatLogoUrl)}
              disabled={!canEdit || isSaving}
              onChange={(event) => {
                markDirty()
                if (!event.target.checked) setChatLogoUrl(null)
              }}
            />
            Keep current reviewed logo
          </label>
        ) : null}
        {chatBannerUrl ? (
          <label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-pf-deep">
            <input
              type="checkbox"
              checked={Boolean(chatBannerUrl)}
              disabled={!canEdit || isSaving}
              onChange={(event) => {
                markDirty()
                if (!event.target.checked) setChatBannerUrl(null)
              }}
            />
            Keep current reviewed banner
          </label>
        ) : null}
        {!chatLogoUrl && !chatBannerUrl ? (
          <p className="mt-3 text-sm text-pf-deep/65">No reviewed branding assets are attached.</p>
        ) : null}
        {brandingAssets.length ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(['logo', 'banner'] as const).map((role) => {
              const selected = role === 'logo' ? chatLogoDerivativeId : chatBannerDerivativeId
              return (
                <label
                  key={role}
                  className="block text-xs font-semibold uppercase tracking-wide text-pf-deep/70"
                >
                  {role} asset
                  <select
                    className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-pf-white px-3 text-sm font-normal normal-case tracking-normal text-pf-deep"
                    value={selected ?? ''}
                    disabled={!canEdit || isSaving}
                    onChange={(event) => {
                      markDirty()
                      const value = event.target.value || null
                      if (role === 'logo') {
                        setChatLogoDerivativeId(value)
                        setChatLogoUrl(null)
                      } else {
                        setChatBannerDerivativeId(value)
                        setChatBannerUrl(null)
                      }
                    }}
                  >
                    <option value="">No reviewed asset</option>
                    {brandingAssets.map((asset) => (
                      <option key={asset.derivativeId} value={asset.derivativeId}>
                        {asset.altText}
                      </option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
        ) : null}
        {brandingPage.nextCursor ? (
          <button
            type="button"
            disabled={!canEdit || isSaving || isLoadingAssets}
            onClick={loadMoreAssets}
            className="mt-4 min-h-11 rounded-xl border border-pf-light bg-pf-white px-4 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent disabled:opacity-50"
          >
            {isLoadingAssets ? 'Loading reviewed assets…' : 'Load more reviewed assets'}
          </button>
        ) : null}
        {assetLoadError ? (
          <p className="mt-2 text-sm text-rose-700" role="alert">
            {assetLoadError}
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-sm font-semibold text-pf-deep">Colour theme</p>
        <p className="mt-1 text-xs leading-5 text-pf-deep/70">
          Choose a preset for light mode. The custom colour below overrides its accent.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {CHAT_THEME_PRESETS.map((theme) => (
            <button
              key={theme.value}
              type="button"
              aria-pressed={chatTheme === theme.value}
              disabled={!canEdit || isSaving || darkMode}
              onClick={() => {
                markDirty()
                setChatTheme(theme.value)
              }}
              className={[
                'rounded-2xl border p-4 text-left transition',
                chatTheme === theme.value
                  ? 'border-pf-accent bg-pf-accent/5 ring-2 ring-pf-accent/30'
                  : 'border-pf-light bg-pf-white hover:border-pf-accent/50',
                'disabled:cursor-not-allowed disabled:opacity-50',
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

      <fieldset className="border-y border-pf-light py-5" disabled={!canEdit || isSaving}>
        <legend className="text-sm font-semibold text-pf-deep">Place card references</legend>
        <p className="mt-1 text-xs leading-5 text-pf-deep/70">
          Photos appear only for a place mentioned in the answer and only while its review remains
          valid.
        </p>
        <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-pf-deep">
          <input
            type="checkbox"
            checked={chatShowPhotos}
            onChange={(event) => {
              markDirty()
              setChatShowPhotos(event.target.checked)
              if (!event.target.checked) setChatShowLinks(false)
            }}
          />
          Show reviewed photos for places mentioned in an answer
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm text-pf-deep">
          <input
            type="checkbox"
            checked={chatShowLinks}
            disabled={!canEdit || isSaving || !chatShowPhotos}
            onChange={(event) => {
              markDirty()
              setChatShowLinks(event.target.checked)
            }}
          />
          Link photo credits to their source
        </label>
        <p className="text-xs leading-5 text-pf-deep/70">
          Photo credits remain visible as text when source links are off.
        </p>
      </fieldset>

      <div className="flex items-start justify-between gap-4 rounded-2xl border border-pf-light bg-pf-white p-4">
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
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-pf-deep">Dark mode (Neon)</p>
            <p className="mt-0.5 text-xs leading-5 text-pf-deep/70">
              Replaces the light preset with a glowing dark palette derived from your accent colour.
              Turn dark mode off before choosing a light preset.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Use dark mode"
          aria-checked={darkMode}
          disabled={!canEdit || isSaving}
          onClick={toggleDarkMode}
          className={[
            'relative mt-1 inline-flex h-11 w-12 flex-shrink-0 items-center rounded-full transition',
            darkMode ? 'bg-pf-primary' : 'bg-pf-light',
            'disabled:cursor-not-allowed disabled:opacity-50',
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
        <p id="accent-color-help" className="mt-1 text-xs leading-5 text-pf-deep/70">
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
            disabled={!canEdit || isSaving}
            aria-invalid={invalidAccent}
            aria-describedby={
              invalidAccent && saveError
                ? 'accent-color-help accent-color-error'
                : 'accent-color-help'
            }
            onChange={(event) => {
              markDirty()
              setChatAccentColor(event.target.value)
            }}
            className="w-40 rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 font-mono text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          />
          <div
            className="h-10 w-10 flex-shrink-0 rounded-full border border-pf-light"
            style={{ backgroundColor: palettePreview.accent }}
            role="img"
            aria-label="Colour preview"
          />
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-pf-deep">Font</p>
        <p className="mt-1 text-xs leading-5 text-pf-deep/70">
          Choose the typeface used throughout the guest chat.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {CHAT_FONT_OPTIONS.map((font) => (
            <button
              key={font.value}
              type="button"
              aria-pressed={chatFont === font.value}
              disabled={!canEdit || isSaving}
              onClick={() => {
                markDirty()
                setChatFont(font.value)
              }}
              className={[
                'rounded-2xl border p-4 text-left transition',
                chatFont === font.value
                  ? 'border-pf-accent bg-pf-accent/5 ring-2 ring-pf-accent/30'
                  : 'border-pf-light bg-pf-white hover:border-pf-accent/50',
                'disabled:cursor-not-allowed disabled:opacity-50',
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
        <p
          id={invalidAccent ? 'accent-color-error' : undefined}
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
        >
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
        >
          Design saved for this venue. Reload the visitor guide to check the saved appearance.
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-live="polite"
            disabled={isSaving || !venue?.id}
            onClick={handleSave}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-6 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save design'}
          </button>
          <button
            type="button"
            disabled={isSaving || !isDirty}
            onClick={() => {
              setChatTheme(savedDesign.chatTheme)
              setDarkMode(savedDesign.darkMode)
              setChatAccentColor(savedDesign.chatAccentColor)
              setChatFont(savedDesign.chatFont)
              setChatLogoUrl(savedDesign.chatLogoUrl)
              setChatBannerUrl(savedDesign.chatBannerUrl)
              setChatLogoDerivativeId(savedDesign.chatLogoDerivativeId ?? null)
              setChatBannerDerivativeId(savedDesign.chatBannerDerivativeId ?? null)
              setChatShowPhotos(savedDesign.chatShowPhotos)
              setChatShowLinks(savedDesign.chatShowLinks)
              setSaveError(null)
              setSaved(false)
            }}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-semibold text-pf-deep transition hover:border-pf-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset changes
          </button>
        </div>
      ) : (
        <p className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep/70">
          Your role can view visitor branding, but only venue managers and owners can edit it.
        </p>
      )}
    </div>
  )
}
