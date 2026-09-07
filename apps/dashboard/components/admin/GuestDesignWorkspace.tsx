'use client'

import { useEffect, useRef, useState } from 'react'

import {
  CHAT_FONT_OPTIONS,
  CHAT_THEME_PRESETS,
  getChatPalette,
  isHexColor,
  TorchikoIcon,
} from '@pathfinder/ui'

import { useTRPCClient } from '../../lib/trpc'

type GuestDesign = {
  id: string
  name: string
  description: string | null
  guideMode: string
  aiGuideName: string | null
  chatTheme: string | null
  chatAccentColor: string | null
  chatFont: string | null
  chatLogoUrl: string | null
  chatBannerUrl: string | null
  chatLogoDerivativeId?: string | null
  chatBannerDerivativeId?: string | null
  chatShowPhotos?: boolean
  chatShowLinks?: boolean
  updatedAt: Date
}

type BrandingAsset = {
  derivativeId: string
  assetId: string
  altText: string
  caption: string | null
  deliveryPath: string
  sourceObjectGeneration: string
  sha256: string
  approvedReviewSequence: number
}
type BrandingAssetPage = { items: BrandingAsset[]; nextCursor: string | null }
const EMPTY_BRANDING_ASSET_PAGE: BrandingAssetPage = { items: [], nextCursor: null }

const themeValues = ['default', 'forest', 'sunset', 'midnight', 'rose', 'dark'] as const
type Theme = (typeof themeValues)[number]
type Font = (typeof CHAT_FONT_OPTIONS)[number]['value']

function theme(value: string | null): Theme {
  return themeValues.includes(value as Theme) ? (value as Theme) : 'default'
}

function font(value: string | null): Font {
  return CHAT_FONT_OPTIONS.some((option) => option.value === value)
    ? (value as Font)
    : CHAT_FONT_OPTIONS[0]!.value
}

export function GuestDesignWorkspace({
  tenantId,
  venueId,
  initial,
  initialBrandingAssets = EMPTY_BRANDING_ASSET_PAGE,
}: {
  tenantId: string
  venueId: string
  initial: GuestDesign
  initialBrandingAssets?: BrandingAssetPage
}) {
  const client = useTRPCClient()
  const [chatTheme, setChatTheme] = useState<Theme>(() => theme(initial.chatTheme))
  const [accent, setAccent] = useState(initial.chatAccentColor ?? '')
  const [chatFont, setChatFont] = useState<Font>(() => font(initial.chatFont))
  const [logoUrl, setLogoUrl] = useState(initial.chatLogoUrl)
  const [bannerUrl, setBannerUrl] = useState(initial.chatBannerUrl)
  const [keepLogo, setKeepLogo] = useState(Boolean(initial.chatLogoUrl))
  const [keepBanner, setKeepBanner] = useState(Boolean(initial.chatBannerUrl))
  const [logoDerivativeId, setLogoDerivativeId] = useState(initial.chatLogoDerivativeId ?? null)
  const [bannerDerivativeId, setBannerDerivativeId] = useState(
    initial.chatBannerDerivativeId ?? null,
  )
  const [savedLogoDerivativeId, setSavedLogoDerivativeId] = useState(
    initial.chatLogoDerivativeId ?? null,
  )
  const [savedBannerDerivativeId, setSavedBannerDerivativeId] = useState(
    initial.chatBannerDerivativeId ?? null,
  )
  const [brandingAssets, setBrandingAssets] = useState(initialBrandingAssets)
  const [showPhotos, setShowPhotos] = useState(initial.chatShowPhotos ?? false)
  const [showLinks, setShowLinks] = useState(initial.chatShowLinks ?? false)
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [revision, setRevision] = useState(initial.updatedAt)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const inFlight = useRef(false)
  const generation = useRef(0)
  const scope = `${tenantId}:${venueId}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  useEffect(() => {
    generation.current += 1
    inFlight.current = false
    setChatTheme(theme(initial.chatTheme))
    setAccent(initial.chatAccentColor ?? '')
    setChatFont(font(initial.chatFont))
    setLogoUrl(initial.chatLogoUrl)
    setBannerUrl(initial.chatBannerUrl)
    setKeepLogo(Boolean(initial.chatLogoUrl))
    setKeepBanner(Boolean(initial.chatBannerUrl))
    setLogoDerivativeId(initial.chatLogoDerivativeId ?? null)
    setBannerDerivativeId(initial.chatBannerDerivativeId ?? null)
    setSavedLogoDerivativeId(initial.chatLogoDerivativeId ?? null)
    setSavedBannerDerivativeId(initial.chatBannerDerivativeId ?? null)
    setBrandingAssets(initialBrandingAssets)
    setShowPhotos(initial.chatShowPhotos ?? false)
    setShowLinks(initial.chatShowLinks ?? false)
    setRevision(initial.updatedAt)
    setBusy(false)
    setNotice(null)
  }, [initial, initialBrandingAssets, tenantId, venueId])

  const normalizedAccent = accent.trim()
  const invalidAccent = normalizedAccent !== '' && !isHexColor(normalizedAccent)
  const accentValue = isHexColor(normalizedAccent) ? normalizedAccent : null
  const palette = getChatPalette(chatTheme, accentValue)
  const fontFamily = `var(${CHAT_FONT_OPTIONS.find((option) => option.value === chatFont)!.cssVar})`
  const guideName = initial.aiGuideName?.trim() || `${initial.name} Guide`
  const logoAsset = brandingAssets.items.find((asset) => asset.derivativeId === logoDerivativeId)
  const bannerAsset = brandingAssets.items.find(
    (asset) => asset.derivativeId === bannerDerivativeId,
  )
  const effectiveLogoUrl = logoAsset?.deliveryPath ?? logoUrl
  const effectiveBannerUrl = bannerAsset?.deliveryPath ?? bannerUrl

  async function loadMoreAssets() {
    if (!brandingAssets.nextCursor || loadingAssets) return
    setLoadingAssets(true)
    setNotice(null)
    try {
      const next = await client.admin.listGuestBrandingAssets.query({
        tenantId,
        venueId,
        cursor: brandingAssets.nextCursor,
      })
      setBrandingAssets((current) => ({
        items: [...current.items, ...next.items],
        nextCursor: next.nextCursor,
      }))
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'More reviewed assets could not be loaded.',
      )
    } finally {
      setLoadingAssets(false)
    }
  }

  async function save() {
    if (inFlight.current || invalidAccent) return
    inFlight.current = true
    setBusy(true)
    setNotice(null)
    const current = ++generation.current
    const submittedScope = scope
    try {
      const saved = await client.admin.updateGuestDesign.mutate({
        tenantId,
        venueId,
        expectedUpdatedAt: revision,
        fields: {
          chatTheme,
          chatAccentColor: accentValue,
          chatFont,
          chatShowPhotos: showPhotos,
          chatShowLinks: showLinks,
          chatLogoUrl: keepLogo ? logoUrl : null,
          chatBannerUrl: keepBanner ? bannerUrl : null,
          ...(logoDerivativeId !== savedLogoDerivativeId
            ? {
                chatLogoDerivativeId: logoDerivativeId,
                chatLogoDerivativeReceipt: logoAsset
                  ? {
                      assetId: logoAsset.assetId,
                      derivativeId: logoAsset.derivativeId,
                      sourceObjectGeneration: logoAsset.sourceObjectGeneration,
                      sha256: logoAsset.sha256,
                      approvedReviewSequence: logoAsset.approvedReviewSequence,
                    }
                  : null,
              }
            : {}),
          ...(bannerDerivativeId !== savedBannerDerivativeId
            ? {
                chatBannerDerivativeId: bannerDerivativeId,
                chatBannerDerivativeReceipt: bannerAsset
                  ? {
                      assetId: bannerAsset.assetId,
                      derivativeId: bannerAsset.derivativeId,
                      sourceObjectGeneration: bannerAsset.sourceObjectGeneration,
                      sha256: bannerAsset.sha256,
                      approvedReviewSequence: bannerAsset.approvedReviewSequence,
                    }
                  : null,
              }
            : {}),
        },
      })
      if (current !== generation.current || submittedScope !== scopeRef.current) return
      setRevision(saved.updatedAt)
      setLogoUrl(saved.chatLogoUrl)
      setBannerUrl(saved.chatBannerUrl)
      setLogoDerivativeId(saved.chatLogoDerivativeId ?? logoDerivativeId)
      setBannerDerivativeId(saved.chatBannerDerivativeId ?? bannerDerivativeId)
      setSavedLogoDerivativeId(saved.chatLogoDerivativeId ?? logoDerivativeId)
      setSavedBannerDerivativeId(saved.chatBannerDerivativeId ?? bannerDerivativeId)
      setKeepLogo(Boolean(saved.chatLogoUrl || saved.chatLogoDerivativeId))
      setKeepBanner(Boolean(saved.chatBannerUrl || saved.chatBannerDerivativeId))
      setNotice(saved.replayed ? 'This exact design was already saved.' : 'Guest design saved.')
    } catch (error) {
      if (current !== generation.current || submittedScope !== scopeRef.current) return
      setNotice(
        error instanceof Error
          ? error.message
          : 'The design could not be confirmed. Retry the unchanged form or refresh.',
      )
    } finally {
      if (current === generation.current && submittedScope === scopeRef.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
      <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-7">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Guest presentation
        </p>
        <h2 className="mt-1 text-2xl font-semibold text-pf-deep">Brand the guest guide</h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/70">
          These settings change presentation only. They do not publish content or alter the
          guide&apos;s answers.
        </p>

        <fieldset className="mt-6" disabled={busy}>
          <legend className="text-sm font-semibold text-pf-deep">Theme</legend>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[...CHAT_THEME_PRESETS, { value: 'dark', label: 'Dark', accent: '#3A7BD5' }].map(
              (option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={chatTheme === option.value}
                  onClick={() => setChatTheme(option.value as Theme)}
                  className="min-h-11 rounded-xl border border-pf-light p-3 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent aria-pressed:border-pf-primary aria-pressed:bg-pf-primary/5"
                >
                  <span
                    className="mr-2 inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: option.accent }}
                    aria-hidden="true"
                  />
                  {option.label}
                </button>
              ),
            )}
          </div>
        </fieldset>

        <label className="mt-6 block text-sm font-semibold text-pf-deep" htmlFor="guest-accent">
          Accent colour
        </label>
        <input
          id="guest-accent"
          value={accent}
          disabled={busy}
          aria-invalid={invalidAccent}
          aria-describedby={invalidAccent ? 'guest-accent-error' : 'guest-accent-help'}
          onChange={(event) => setAccent(event.target.value)}
          placeholder="#3A7BD5"
          maxLength={7}
          className="mt-2 min-h-11 w-full rounded-xl border border-pf-light px-3 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        />
        <p id="guest-accent-help" className="mt-1 text-xs text-pf-deep/65">
          Leave blank to use the selected theme&apos;s reviewed default.
        </p>

        <fieldset className="mt-6 rounded-2xl border border-pf-light p-4" disabled={busy}>
          <legend className="px-1 text-sm font-semibold text-pf-deep">Place card references</legend>
          <label className="flex min-h-11 items-center gap-3 text-sm text-pf-deep">
            <input
              type="checkbox"
              checked={showPhotos}
              onChange={(event) => setShowPhotos(event.target.checked)}
            />
            Show reviewed photos for places mentioned in an answer
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm text-pf-deep">
            <input
              type="checkbox"
              checked={showLinks}
              disabled={!showPhotos || busy}
              onChange={(event) => setShowLinks(event.target.checked)}
            />
            Link photo credits to their approved source
          </label>
          <p className="mt-1 text-xs leading-5 text-pf-deep/65">
            Credits remain visible as text when source links are off. Revoked media disappears
            automatically.
          </p>
        </fieldset>
        {invalidAccent ? (
          <p id="guest-accent-error" className="mt-1 text-xs text-rose-700">
            Enter a six-digit hex colour such as #3A7BD5.
          </p>
        ) : null}

        <label className="mt-6 block text-sm font-semibold text-pf-deep" htmlFor="guest-font">
          Font
        </label>
        <select
          id="guest-font"
          value={chatFont}
          disabled={busy}
          onChange={(event) => setChatFont(event.target.value as Font)}
          className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          {CHAT_FONT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="mt-6 rounded-2xl border border-pf-light bg-pf-surface/50 p-4">
          <h3 className="text-sm font-semibold text-pf-deep">Reviewed branding assets</h3>
          <p className="mt-1 text-xs leading-5 text-pf-deep/70">
            This workspace cannot upload or approve assets. It can only retain or clear references
            already reviewed and used by the Guest experience.
          </p>
          {brandingAssets.items.length ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(['logo', 'banner'] as const).map((role) => (
                <label
                  key={role}
                  className="text-xs font-semibold uppercase tracking-wide text-pf-deep/60"
                >
                  {role} asset
                  <select
                    className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm font-normal normal-case tracking-normal text-pf-deep"
                    value={(role === 'logo' ? logoDerivativeId : bannerDerivativeId) ?? ''}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value || null
                      if (role === 'logo') {
                        setLogoDerivativeId(value)
                        setLogoUrl(null)
                        setKeepLogo(Boolean(value))
                      } else {
                        setBannerDerivativeId(value)
                        setBannerUrl(null)
                        setKeepBanner(Boolean(value))
                      }
                    }}
                  >
                    <option value="">No reviewed asset</option>
                    {brandingAssets.items.map((asset) => (
                      <option key={asset.derivativeId} value={asset.derivativeId}>
                        {asset.altText}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : null}
          {brandingAssets.nextCursor ? (
            <button
              type="button"
              onClick={loadMoreAssets}
              disabled={busy || loadingAssets}
              className="mt-4 min-h-11 rounded-xl border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
            >
              {loadingAssets ? 'Loading reviewed assets…' : 'Load more reviewed assets'}
            </button>
          ) : null}
          {logoUrl ? (
            <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-pf-deep">
              <input
                type="checkbox"
                checked={keepLogo}
                disabled={busy}
                onChange={(event) => setKeepLogo(event.target.checked)}
              />
              Keep current reviewed logo
            </label>
          ) : (
            <p className="mt-3 text-sm text-pf-deep/65">No reviewed logo is attached.</p>
          )}
          {bannerUrl ? (
            <label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-pf-deep">
              <input
                type="checkbox"
                checked={keepBanner}
                disabled={busy}
                onChange={(event) => setKeepBanner(event.target.checked)}
              />
              Keep current reviewed banner
            </label>
          ) : (
            <p className="mt-2 text-sm text-pf-deep/65">No reviewed banner is attached.</p>
          )}
        </div>

        <div className="mt-6 rounded-2xl border border-pf-light p-4 text-sm text-pf-deep/70">
          <p>
            Assistant name: <strong className="text-pf-deep">{guideName}</strong>
          </p>
          <p className="mt-1">
            Welcome copy: {initial.description ?? 'The Guest experience uses its standard welcome.'}
          </p>
          <p className="mt-2 text-xs">
            Assistant identity and welcome content are managed in their existing reviewed content
            workflows, not changed here.
          </p>
        </div>

        {notice ? (
          <p className="mt-5 rounded-xl bg-pf-surface p-3 text-sm text-pf-deep" role="status">
            {notice}
          </p>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={busy || invalidAccent}
          className="mt-5 min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save guest design'}
        </button>
      </section>

      <section aria-labelledby="guest-preview-title" className="xl:sticky xl:top-6 xl:self-start">
        <h2 id="guest-preview-title" className="text-lg font-semibold text-pf-deep">
          Branding style preview
        </h2>
        <p className="mt-1 text-xs text-pf-deep/65">
          A non-literal preview of the saved colours, font, and reviewed imagery. Guest prompts and
          conversation content are intentionally not simulated here.
        </p>
        <div
          className="mt-3 overflow-hidden rounded-[2rem] border border-pf-light shadow-lg"
          style={{ backgroundColor: palette.bg, color: palette.text }}
        >
          <header
            className="min-h-28 border-b p-5"
            style={{
              borderColor: palette.border,
              backgroundColor: palette.card,
              ...(keepBanner && effectiveBannerUrl
                ? {
                    backgroundImage: `linear-gradient(rgba(0,0,0,.42),rgba(0,0,0,.42)),url(${effectiveBannerUrl})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    color: '#fff',
                  }
                : {}),
            }}
          >
            <div className="flex items-center gap-3">
              {keepLogo && effectiveLogoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={effectiveLogoUrl} alt="" className="h-9 w-9 rounded-lg object-contain" />
              ) : (
                <TorchikoIcon className="text-sm" />
              )}
              <h3 className="text-xl font-semibold">{guideName}</h3>
            </div>
          </header>
          <div className="min-h-80 p-4 sm:p-6" style={{ fontFamily }}>
            <div
              className="rounded-3xl border p-5"
              style={{ backgroundColor: palette.card, borderColor: palette.border }}
            >
              <p className="font-semibold">{initial.name}</p>
              <p className="mt-2 text-sm leading-6" style={{ color: palette.textMuted }}>
                {initial.description ?? 'No venue description is currently saved.'}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
