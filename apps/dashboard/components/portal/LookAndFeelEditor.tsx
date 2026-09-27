'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ImagePlus, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react'

import {
  chatAppearanceEquals,
  parseChatAppearance,
  type ChatAppearance,
} from '@pathfinder/contracts/chat-appearance'
import { getChatPalette, resolveChatAppearance } from '@pathfinder/ui/theme'

import { browserUuid } from '../../lib/browser-uuid'
import {
  IntakeTransferError,
  transferIntakeFile,
  type IntakeTransferApi,
} from '../../lib/intake-file-transfer'
import { useTRPCClient } from '../../lib/trpc'
import { useIntakeTransferApi } from '../../lib/use-intake-transfer-api'
import { ColorChoice } from './ColorChoice'
import { LiveVisitorPreview, type PreviewMedia } from './LiveVisitorPreview'
import {
  PortalNotice,
  PortalPage,
  portalButtonPrimary,
  portalButtonSecondary,
  portalFocus,
  portalInput,
  portalTextLink,
} from './PortalPrimitives'

export const BRANDING_REVIEW_SUBJECTS = {
  logo: 'New logo for the visitor guide',
  background: 'New background photo for the visitor guide',
} as const

type AssetRole = keyof typeof BRANDING_REVIEW_SUBJECTS

export type ApprovedBrandingAsset = {
  derivativeId: string
  assetId: string
  altText: string
  deliveryPath: string
  sourceObjectGeneration: string
  sha256: string
  approvedReviewSequence: number
}

type AssetChoice =
  | { kind: 'none' }
  | { kind: 'derivative'; derivativeId: string; asset?: ApprovedBrandingAsset }
  | { kind: 'url'; url: string }

type LookAndFeelVenue = {
  id: string
  name: string
  slug: string
  updatedAt: string
  chatTheme: string | null
  chatAccentColor: string | null
  chatFont: string | null
  chatAppearance: unknown
  chatLogoUrl: string | null
  chatBannerUrl: string | null
  chatLogoDerivativeId: string | null
  chatBannerDerivativeId: string | null
}

type SaveInput = {
  venueId: string
  expectedUpdatedAt: Date
  chatAppearance: ChatAppearance
  chatLogoUrl?: null
  chatBannerUrl?: null
  chatLogoDerivativeId?: string | null
  chatBannerDerivativeId?: string | null
  chatLogoDerivativeReceipt?: ReturnType<typeof toReceipt>
  chatBannerDerivativeReceipt?: ReturnType<typeof toReceipt>
}

export type LookAndFeelApi = IntakeTransferApi & {
  saveDesign: (input: SaveInput) => Promise<{ updatedAt: Date | string; chatAppearance?: unknown }>
  requestBrandingReview: (input: {
    operationId: string
    venueId: string
    category: 'BRANDING'
    subject: string
    body: string
    attachments: Array<{ intakeUploadId: string }>
  }) => Promise<{ request: { id: string } }>
}

type PendingUpload = {
  file: File
  phase: 'uploading' | 'checking' | 'in-review' | 'failed'
  error: string | null
  uploadId?: string
  operationId: string
  href?: string
}

const BRANDING_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const BRANDING_MAX_BYTES = 12 * 1024 * 1024

const BUBBLE_SWATCHES = ['#FFFFFF', '#F1ECE2', '#DCE8F2', '#DDEBE3', '#1F3A5F', '#2D6A4F']
const TEXT_SWATCHES = ['#FFFFFF', '#102F50', '#1C1C1C', '#2D6A4F', '#6B3A1F']

const BUBBLE_STYLES = [
  { id: 'both', label: 'Both in bubbles', userBubble: true, assistantBubble: true },
  { id: 'visitor', label: 'Visitor bubble only', userBubble: true, assistantBubble: false },
  { id: 'text', label: 'No bubbles', userBubble: false, assistantBubble: false },
] as const

function toReceipt(asset: ApprovedBrandingAsset | undefined) {
  if (!asset?.sourceObjectGeneration || !asset.sha256 || !asset.approvedReviewSequence) return null
  return {
    assetId: asset.assetId,
    derivativeId: asset.derivativeId,
    sourceObjectGeneration: asset.sourceObjectGeneration,
    sha256: asset.sha256,
    approvedReviewSequence: asset.approvedReviewSequence,
  }
}

function savedChoice(
  derivativeId: string | null,
  url: string | null,
  approved: ApprovedBrandingAsset[],
): AssetChoice {
  if (derivativeId) {
    const asset = approved.find((candidate) => candidate.derivativeId === derivativeId)
    return asset
      ? { kind: 'derivative', derivativeId, asset }
      : { kind: 'derivative', derivativeId }
  }
  if (url) return { kind: 'url', url }
  return { kind: 'none' }
}

function sameChoice(left: AssetChoice, right: AssetChoice) {
  if (left.kind !== right.kind) return false
  if (left.kind === 'derivative' && right.kind === 'derivative')
    return left.derivativeId === right.derivativeId
  if (left.kind === 'url' && right.kind === 'url') return left.url === right.url
  return true
}

function deliveryPath(choice: AssetChoice, slug: string): string | null {
  if (choice.kind !== 'derivative') return null
  return (
    choice.asset?.deliveryPath ??
    `/api/venue-media/${choice.derivativeId}?venue=${encodeURIComponent(slug)}`
  )
}

function useLookAndFeelApi(): LookAndFeelApi {
  const client = useTRPCClient()
  const transfer = useIntakeTransferApi()
  return useMemo(
    () => ({
      ...transfer,
      saveDesign: (input) =>
        client.venue.updateChatDesign.mutate(input) as Promise<{
          updatedAt: Date | string
          chatAppearance?: unknown
        }>,
      requestBrandingReview: (input) => client.support.createRequest.mutate(input),
    }),
    [client, transfer],
  )
}

type EditorProps = {
  venues: Array<{ id: string; name: string }>
  venue: LookAndFeelVenue
  canEdit: boolean
  visibleToVisitors: boolean
  approvedAssets: ApprovedBrandingAsset[]
  pendingReviews: Record<AssetRole, { href: string } | null>
  previewOrigin: string | null
  /** The visitor app's origin, which serves reviewed venue media. */
  mediaOrigin: string | null
}

export function LookAndFeelEditor(props: EditorProps) {
  const api = useLookAndFeelApi()
  const router = useRouter()
  return <LookAndFeelEditorView {...props} api={api} onSaved={() => router.refresh()} />
}

export function LookAndFeelEditorView({
  venues,
  venue,
  canEdit,
  visibleToVisitors,
  approvedAssets,
  pendingReviews,
  previewOrigin,
  mediaOrigin,
  api,
  onSaved,
}: EditorProps & { api: LookAndFeelApi; onSaved?: () => void }) {
  const titleId = useId()
  const initial = useMemo(
    () => ({
      appearance: parseChatAppearance(venue.chatAppearance),
      logo: savedChoice(venue.chatLogoDerivativeId, venue.chatLogoUrl, approvedAssets),
      background: savedChoice(venue.chatBannerDerivativeId, venue.chatBannerUrl, approvedAssets),
    }),
    [venue, approvedAssets],
  )
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState(initial)
  const revision = useRef(new Date(venue.updatedAt))
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>(
    'idle',
  )
  const [pending, setPending] = useState<Partial<Record<AssetRole, PendingUpload>>>({})
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit')

  const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
  const hasBackground = draft.background.kind !== 'none' || Boolean(pending.background)
  const tokens = resolveChatAppearance(palette, draft.appearance, {
    hasBackgroundImage: hasBackground && draft.appearance.background.mode === 'image',
  })
  // What the defaults resolve to, so "Default" swatches show the real colour visitors get.
  const defaults = resolveChatAppearance(
    palette,
    {
      ...draft.appearance,
      userBubbleColor: null,
      userTextColor: null,
      assistantSurfaceColor: null,
      assistantTextColor: null,
    },
    { hasBackgroundImage: hasBackground && draft.appearance.background.mode === 'image' },
  )
  const correction = (field: 'userTextColor' | 'assistantTextColor') =>
    tokens.corrections.find((item) => item.field === field)

  const dirty =
    !chatAppearanceEquals(draft.appearance, saved.appearance) ||
    !sameChoice(draft.logo, saved.logo) ||
    !sameChoice(draft.background, saved.background)

  useEffect(() => {
    if (!dirty) return
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function setAppearance(change: Partial<ChatAppearance>) {
    setSaveState('idle')
    setDraft((current) => ({ ...current, appearance: { ...current.appearance, ...change } }))
  }

  function setAsset(role: AssetRole, choice: AssetChoice) {
    setSaveState('idle')
    setDraft((current) => ({
      ...current,
      [role]: choice,
      ...(role === 'background'
        ? {
            appearance: {
              ...current.appearance,
              background: {
                ...current.appearance.background,
                mode: choice.kind === 'none' ? ('none' as const) : ('image' as const),
              },
            },
          }
        : {}),
    }))
  }

  async function save() {
    if (!canEdit || saveState === 'saving' || !dirty) return
    setSaveState('saving')
    const input: SaveInput = {
      venueId: venue.id,
      expectedUpdatedAt: revision.current,
      chatAppearance: draft.appearance,
    }
    for (const role of ['logo', 'background'] as const) {
      const next = draft[role]
      if (sameChoice(next, saved[role])) continue
      const derivativeKey = role === 'logo' ? 'chatLogoDerivativeId' : 'chatBannerDerivativeId'
      const receiptKey =
        role === 'logo' ? 'chatLogoDerivativeReceipt' : 'chatBannerDerivativeReceipt'
      const urlKey = role === 'logo' ? 'chatLogoUrl' : 'chatBannerUrl'
      if (next.kind === 'none') {
        input[derivativeKey] = null
        input[receiptKey] = null
        if (saved[role].kind === 'url') input[urlKey] = null
      } else if (next.kind === 'derivative') {
        input[derivativeKey] = next.derivativeId
        input[receiptKey] = toReceipt(next.asset)
        if (saved[role].kind === 'url') input[urlKey] = null
      }
    }
    try {
      const result = await api.saveDesign(input)
      revision.current = new Date(result.updatedAt)
      const confirmed = {
        ...draft,
        appearance:
          result.chatAppearance !== undefined
            ? parseChatAppearance(result.chatAppearance)
            : draft.appearance,
      }
      setSaved(confirmed)
      setDraft(confirmed)
      setSaveState('saved')
      onSaved?.()
    } catch (error) {
      const code = (error as { data?: { code?: string } } | null)?.data?.code
      setSaveState(code === 'CONFLICT' ? 'conflict' : 'error')
    }
  }

  function discard() {
    setDraft(saved)
    setSaveState('idle')
  }

  async function upload(role: AssetRole, file: File) {
    if (!BRANDING_TYPES.includes(file.type)) {
      setPending((current) => ({
        ...current,
        [role]: {
          file,
          phase: 'failed',
          error: 'Choose a PNG, JPG or WebP image.',
          operationId: browserUuid(),
        },
      }))
      return
    }
    if (file.size > BRANDING_MAX_BYTES) {
      setPending((current) => ({
        ...current,
        [role]: {
          file,
          phase: 'failed',
          error: 'This image is larger than 12 MB. Try a smaller copy.',
          operationId: browserUuid(),
        },
      }))
      return
    }
    const entry: PendingUpload = {
      file,
      phase: 'uploading',
      error: null,
      operationId: browserUuid(),
    }
    setPending((current) => ({ ...current, [role]: entry }))
    await sendForReview(role, entry)
  }

  async function sendForReview(role: AssetRole, entry: PendingUpload) {
    const update = (patch: Partial<PendingUpload>) =>
      setPending((current) =>
        current[role]?.operationId === entry.operationId
          ? { ...current, [role]: { ...current[role]!, ...patch } }
          : current,
      )
    try {
      let uploadId = entry.uploadId
      if (!uploadId) {
        update({ phase: 'uploading', error: null })
        const outcome = await transferIntakeFile({
          venueId: venue.id,
          file: entry.file,
          category: 'PHOTO',
          api,
        })
        if (outcome.kind === 'rejected') {
          update({ phase: 'failed', error: 'Torchiko couldn’t accept this image. Try another.' })
          return
        }
        uploadId = outcome.uploadId
        update({ uploadId })
        if (outcome.kind === 'security-pending') {
          update({ phase: 'checking' })
          return
        }
      }
      update({ phase: 'uploading', error: null })
      const result = await api.requestBrandingReview({
        operationId: entry.operationId,
        venueId: venue.id,
        category: 'BRANDING',
        subject: BRANDING_REVIEW_SUBJECTS[role],
        body:
          role === 'logo'
            ? 'Please review this logo and use it in our visitor guide.'
            : 'Please review this photo and use it as the background of our visitor guide.',
        attachments: [{ intakeUploadId: uploadId }],
      })
      update({
        phase: 'in-review',
        href: `/support?venue=${encodeURIComponent(venue.id)}&request=${encodeURIComponent(result.request.id)}`,
      })
    } catch (error) {
      const code = (error as { data?: { code?: string } } | null)?.data?.code
      update(
        code === 'NOT_FOUND' && entry.uploadId
          ? { phase: 'checking' }
          : {
              phase: 'failed',
              error:
                error instanceof IntakeTransferError
                  ? error.message
                  : 'This image didn’t reach Torchiko. Check your connection and try again.',
            },
      )
    }
  }

  const previewMedia = (role: AssetRole): PreviewMedia => {
    const upload = pending[role]
    if (upload && upload.phase !== 'failed') return { kind: 'blob', blob: upload.file }
    const path = deliveryPath(draft[role], venue.slug)
    return path ? { kind: 'path', path } : null
  }
  const previewIncludesPending = Boolean(
    (pending.logo && pending.logo.phase !== 'failed') ||
    (pending.background && pending.background.phase !== 'failed'),
  )

  const statusLine =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'error'
        ? null
        : dirty
          ? 'Unsaved changes. Only you can see them, in the preview.'
          : saveState === 'saved'
            ? visibleToVisitors
              ? 'Saved. Visitors see this design now.'
              : 'Saved. Visitors will see it when your guide is published.'
            : visibleToVisitors
              ? 'This is the design visitors see.'
              : 'Visitors will see this design when your guide is published.'

  const bubbleStyle =
    BUBBLE_STYLES.find(
      (style) =>
        style.userBubble === draft.appearance.userBubble &&
        style.assistantBubble === draft.appearance.assistantBubble,
    )?.id ?? null

  const editor = (
    <div className="space-y-5">
      <section
        aria-labelledby={`${titleId}-messages`}
        className="rounded-xl border border-tk-rule bg-tk-card p-5 sm:p-6"
      >
        <h2 id={`${titleId}-messages`} className="font-portal text-[1.45rem] leading-tight">
          Messages
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-tk-soft">
          Colours for each side of the conversation. Text that would be hard to read is adjusted
          automatically, here and for visitors.
        </p>
        <fieldset disabled={!canEdit} className="mt-4">
          <legend className="text-sm font-semibold">Bubble style</legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {BUBBLE_STYLES.map((style) => (
              <label
                key={style.id}
                className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-2.5 text-center text-[0.8rem] font-medium leading-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tk-focus motion-reduce:transition-none ${
                  bubbleStyle === style.id
                    ? 'border-tk-ink bg-tk-ink-wash'
                    : 'border-tk-rule bg-white hover:border-tk-rule-strong'
                }`}
              >
                <input
                  type="radio"
                  name={`${titleId}-bubble-style`}
                  className="sr-only"
                  checked={bubbleStyle === style.id}
                  onChange={() =>
                    setAppearance({
                      userBubble: style.userBubble,
                      assistantBubble: style.assistantBubble,
                    })
                  }
                />
                <span aria-hidden="true" className="flex w-full flex-col gap-1 px-1 py-0.5">
                  <span
                    className={`ml-auto h-2.5 w-3/5 rounded-full ${style.userBubble ? 'bg-tk-ink/70' : 'bg-transparent ring-1 ring-inset ring-tk-rule-strong/60'}`}
                  />
                  <span
                    className={`h-2.5 w-4/5 rounded-full ${style.assistantBubble ? 'bg-tk-rule-strong/70' : 'bg-transparent ring-1 ring-inset ring-tk-rule-strong/60'}`}
                  />
                </span>
                {style.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-5 grid gap-5">
          <fieldset disabled={!canEdit} className="min-w-0">
            <legend className="text-sm font-semibold">Visitor messages</legend>
            <div className="mt-2 space-y-3">
              <ColorChoice
                label="Bubble"
                value={draft.appearance.userBubbleColor}
                automatic={defaults.userBg}
                swatches={BUBBLE_SWATCHES}
                onChange={(userBubbleColor) => setAppearance({ userBubbleColor })}
                note={
                  draft.appearance.userBubble || tokens.userSurface
                    ? null
                    : 'No bubble in this style, so this colour isn’t shown.'
                }
              />
              <ColorChoice
                label="Text"
                value={draft.appearance.userTextColor}
                automatic={defaults.userText}
                swatches={TEXT_SWATCHES}
                onChange={(userTextColor) => setAppearance({ userTextColor })}
                note={
                  correction('userTextColor')
                    ? `Too faint on this bubble, so visitors see ${correction('userTextColor')!.applied.toUpperCase()} instead.`
                    : null
                }
              />
            </div>
          </fieldset>
          <fieldset disabled={!canEdit} className="min-w-0">
            <legend className="text-sm font-semibold">Guide messages</legend>
            <div className="mt-2 space-y-3">
              <ColorChoice
                label="Bubble"
                value={draft.appearance.assistantSurfaceColor}
                automatic={defaults.assistantBg}
                swatches={BUBBLE_SWATCHES}
                onChange={(assistantSurfaceColor) => setAppearance({ assistantSurfaceColor })}
                note={
                  draft.appearance.assistantBubble || tokens.assistantProtected
                    ? null
                    : 'Guide answers have no bubble in this style. Choose “Both in bubbles” to use this colour.'
                }
              />
              <ColorChoice
                label="Text"
                value={draft.appearance.assistantTextColor}
                automatic={defaults.assistantText}
                swatches={TEXT_SWATCHES}
                onChange={(assistantTextColor) => setAppearance({ assistantTextColor })}
                note={
                  correction('assistantTextColor')
                    ? `Too faint on this background, so visitors see ${correction('assistantTextColor')!.applied.toUpperCase()} instead.`
                    : null
                }
              />
            </div>
          </fieldset>
        </div>
      </section>

      <section
        aria-labelledby={`${titleId}-images`}
        className="rounded-xl border border-tk-rule bg-tk-card p-5 sm:p-6"
      >
        <h2 id={`${titleId}-images`} className="font-portal text-[1.45rem] leading-tight">
          Logo and photo
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-tk-soft">
          Both are optional. New images are checked by Torchiko before visitors see them.
        </p>
        <div className="mt-3 divide-y divide-tk-rule">
          {(['logo', 'background'] as const).map((role) => (
            <BrandingAssetRow
              key={role}
              role={role}
              canEdit={canEdit}
              choice={draft[role]}
              slug={venue.slug}
              mediaOrigin={mediaOrigin}
              approvedAssets={approvedAssets}
              pending={pending[role] ?? null}
              pendingReview={pendingReviews[role]}
              placement={draft.appearance.background.mode}
              onPlacement={(mode) =>
                setAppearance({ background: { ...draft.appearance.background, mode } })
              }
              onChoose={(choice) => setAsset(role, choice)}
              onUpload={(file) => void upload(role, file)}
              onRetry={() => {
                const entry = pending[role]
                if (entry) void sendForReview(role, entry)
              }}
              onClearPending={() =>
                setPending((current) => {
                  const next = { ...current }
                  delete next[role]
                  return next
                })
              }
            />
          ))}
        </div>
      </section>

      {!canEdit ? (
        <PortalNotice>
          You can see your visitor guide’s design. A manager or owner on your team can change it.
        </PortalNotice>
      ) : null}
      <p className="text-sm leading-6 text-tk-soft">
        Want to change how the guide sounds or how much detail it gives?{' '}
        <Link
          href={`/ai-controls?venue=${encodeURIComponent(venue.id)}`}
          className={portalTextLink}
        >
          Guide tone and answers
        </Link>
      </p>
    </div>
  )

  const preview = (
    <LiveVisitorPreview
      origin={previewOrigin}
      venueName={venue.name}
      theme={venue.chatTheme}
      font={venue.chatFont}
      accent={venue.chatAccentColor}
      appearance={draft.appearance}
      logo={previewMedia('logo')}
      background={previewMedia('background')}
      caption={
        previewIncludesPending
          ? 'Sample conversation. Includes your new image, which Torchiko hasn’t approved yet.'
          : dirty
            ? 'Sample conversation, showing your unsaved changes.'
            : 'Sample conversation, showing your saved design.'
      }
    />
  )

  return (
    <PortalPage
      title="Look & feel"
      description="Make the visitor guide feel like your place."
      width="wide"
      aside={
        venues.length > 1 ? (
          <div className="w-full sm:w-60">
            <label htmlFor={`${titleId}-venue`} className="mb-1 block text-sm text-tk-soft">
              Venue
            </label>
            <select
              id={`${titleId}-venue`}
              value={venue.id}
              onChange={(event) => {
                if (dirty && !window.confirm('Leave without saving your changes?')) return
                window.location.href = `/look-and-feel?venue=${encodeURIComponent(event.currentTarget.value)}`
              }}
              className={portalInput}
            >
              {venues.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
        ) : null
      }
    >
      <div
        className="mb-4 grid grid-cols-2 rounded-lg border border-tk-rule bg-white p-1 lg:hidden"
        role="tablist"
        aria-label="Look & feel view"
      >
        {(['edit', 'preview'] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={mobileView === view}
            aria-controls={`${titleId}-${view}`}
            onClick={() => setMobileView(view)}
            className={`min-h-11 rounded-md text-sm font-semibold ${portalFocus} ${
              mobileView === view ? 'bg-tk-ink text-white' : 'text-tk-ink'
            }`}
          >
            {view === 'edit' ? 'Edit' : 'Preview'}
          </button>
        ))}
      </div>

      <div className="grid gap-6 pb-24 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:pb-0 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div id={`${titleId}-edit`} className={mobileView === 'edit' ? '' : 'hidden lg:block'}>
          {editor}
        </div>
        <div
          id={`${titleId}-preview`}
          className={`lg:sticky lg:top-6 ${mobileView === 'preview' ? '' : 'hidden lg:block'}`}
        >
          {preview}
        </div>
      </div>

      {canEdit ? (
        <div
          className={`fixed inset-x-0 bottom-0 z-20 border-t border-tk-rule bg-tk-paper px-4 py-3 lg:sticky lg:-mx-10 lg:mt-6 lg:px-10 ${
            dirty || saveState !== 'idle' ? '' : 'max-lg:hidden'
          }`}
        >
          <div className="mx-auto flex max-w-[76rem] flex-wrap items-center gap-3 lg:mx-0">
            <p
              role={saveState === 'error' || saveState === 'conflict' ? 'alert' : 'status'}
              className={`min-w-0 flex-1 text-sm ${
                saveState === 'error' || saveState === 'conflict'
                  ? 'font-medium text-tk-danger'
                  : 'text-tk-soft'
              }`}
            >
              {saveState === 'conflict'
                ? 'Someone else changed this design. Reload the page to see their changes before saving.'
                : saveState === 'error'
                  ? 'Your changes weren’t saved. They’re still here—try again.'
                  : statusLine}
            </p>
            {dirty ? (
              <button
                type="button"
                onClick={discard}
                disabled={saveState === 'saving'}
                className={portalButtonSecondary}
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" /> Discard
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saveState === 'saving'}
              className={portalButtonPrimary}
            >
              {saveState === 'saving' ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              {saveState === 'saving' ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      ) : null}
    </PortalPage>
  )
}

function BrandingAssetRow({
  role,
  canEdit,
  choice,
  slug,
  mediaOrigin,
  approvedAssets,
  pending,
  pendingReview,
  placement,
  onPlacement,
  onChoose,
  onUpload,
  onRetry,
  onClearPending,
}: {
  role: AssetRole
  canEdit: boolean
  choice: AssetChoice
  slug: string
  mediaOrigin: string | null
  approvedAssets: ApprovedBrandingAsset[]
  pending: PendingUpload | null
  pendingReview: { href: string } | null
  placement: 'none' | 'image'
  onPlacement: (mode: 'none' | 'image') => void
  onChoose: (choice: AssetChoice) => void
  onUpload: (file: File) => void
  onRetry: () => void
  onClearPending: () => void
}) {
  const inputId = useId()
  const label = role === 'logo' ? 'Logo' : 'Background photo'
  const [pendingThumb, setPendingThumb] = useState<string | null>(null)
  useEffect(() => {
    if (!pending?.file || typeof URL.createObjectURL !== 'function') {
      setPendingThumb(null)
      return
    }
    const url = URL.createObjectURL(pending.file)
    setPendingThumb(url)
    return () => URL.revokeObjectURL(url)
  }, [pending?.file])
  const savedPath = deliveryPath(choice, slug)
  const savedThumb =
    savedPath && mediaOrigin
      ? new URL(savedPath, mediaOrigin).toString()
      : choice.kind === 'url' && /^https:\/\//u.test(choice.url)
        ? choice.url
        : null
  const selectableAssets = approvedAssets.filter(
    (asset) => choice.kind !== 'derivative' || asset.derivativeId !== choice.derivativeId,
  )

  const status = pending
    ? pending.phase === 'uploading'
      ? 'Sending to Torchiko…'
      : pending.phase === 'checking'
        ? 'Received. Finishing a safety check before review.'
        : pending.phase === 'in-review'
          ? 'Sent for review. Visitors will see it once Torchiko approves it.'
          : (pending.error ?? 'Something went wrong.')
    : pendingReview
      ? 'A new image is in review with Torchiko.'
      : choice.kind === 'none'
        ? 'None'
        : role === 'background'
          ? placement === 'image'
            ? 'Shown behind the conversation'
            : 'Shown at the top of the chat'
          : 'Shown beside your venue name'

  const selectClass = `min-h-11 min-w-0 flex-1 rounded-lg border border-tk-rule-strong bg-white px-2.5 text-sm text-tk-ink sm:max-w-xs ${portalFocus}`

  return (
    <div className="py-4 first:pt-2 last:pb-1">
      <div className="flex items-start gap-3.5">
        <div
          className={`flex h-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-tk-rule bg-tk-paper ${role === 'background' ? 'w-20' : 'w-14'}`}
        >
          {pendingThumb && pending?.phase !== 'failed' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pendingThumb} alt="" className="h-full w-full object-cover" />
          ) : savedThumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={savedThumb}
              alt=""
              className={`h-full w-full ${role === 'logo' ? 'object-contain p-1' : 'object-cover'}`}
            />
          ) : (
            <ImagePlus className="h-5 w-5 text-tk-soft" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{label}</p>
              <p
                role={pending ? 'status' : undefined}
                className={`text-[0.8rem] leading-5 ${pending?.phase === 'failed' ? 'text-tk-danger' : 'text-tk-soft'}`}
              >
                {status}
                {pending?.href || (!pending && pendingReview) ? (
                  <>
                    {' '}
                    <Link href={pending?.href ?? pendingReview!.href} className={portalTextLink}>
                      View in Help
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
            {canEdit ? (
              <div className="flex items-center gap-1.5">
                <input
                  id={inputId}
                  type="file"
                  accept={BRANDING_TYPES.join(',')}
                  className="sr-only"
                  disabled={pending?.phase === 'uploading'}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (file) onUpload(file)
                  }}
                />
                {pending?.phase === 'failed' && pending.uploadId ? (
                  <button type="button" onClick={onRetry} className={portalButtonSecondary}>
                    Try again
                  </button>
                ) : pending?.phase === 'checking' ? (
                  <button type="button" onClick={onRetry} className={portalButtonSecondary}>
                    Send for review
                  </button>
                ) : null}
                <label
                  htmlFor={inputId}
                  className={`${portalButtonSecondary} cursor-pointer has-[:disabled]:opacity-55`}
                >
                  {pending?.phase === 'uploading' ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : null}
                  {choice.kind === 'none' && !pending ? 'Upload' : 'Replace'}
                </label>
                {pending && pending.phase !== 'uploading' ? (
                  <button
                    type="button"
                    aria-label={`Dismiss the new ${label.toLowerCase()}`}
                    onClick={onClearPending}
                    className={`flex h-11 w-11 items-center justify-center rounded-md text-tk-soft hover:bg-tk-ink-wash hover:text-tk-ink ${portalFocus}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : choice.kind !== 'none' ? (
                  <button
                    type="button"
                    aria-label={`Remove ${label.toLowerCase()}`}
                    onClick={() => onChoose({ kind: 'none' })}
                    className={`flex h-11 w-11 items-center justify-center rounded-md text-tk-soft hover:bg-tk-ink-wash hover:text-tk-ink ${portalFocus}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {canEdit && role === 'background' && choice.kind !== 'none' ? (
        <label className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-tk-soft sm:pl-[6.4rem]">
          <span className="w-full sm:w-auto">Placement</span>
          <select
            value={placement}
            onChange={(event) => onPlacement(event.currentTarget.value as 'none' | 'image')}
            className={selectClass}
          >
            <option value="image">Behind the conversation</option>
            <option value="none">Top of the chat</option>
          </select>
        </label>
      ) : null}
      {canEdit && selectableAssets.length ? (
        <label
          className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-tk-soft ${role === 'background' ? 'sm:pl-[6.4rem]' : 'sm:pl-[4.9rem]'}`}
        >
          <span className="w-full sm:w-auto">Or use an approved image</span>
          <select
            value=""
            onChange={(event) => {
              const asset = approvedAssets.find(
                (candidate) => candidate.derivativeId === event.currentTarget.value,
              )
              if (asset) onChoose({ kind: 'derivative', derivativeId: asset.derivativeId, asset })
            }}
            className={selectClass}
          >
            <option value="">Choose…</option>
            {selectableAssets.map((asset) => (
              <option key={asset.derivativeId} value={asset.derivativeId}>
                {asset.altText}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  )
}
