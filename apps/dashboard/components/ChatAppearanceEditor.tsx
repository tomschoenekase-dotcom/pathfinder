'use client'

import { useId, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import {
  DEFAULT_CHAT_APPEARANCE,
  chatAppearanceEquals,
  type ChatAppearance,
} from '@pathfinder/contracts/chat-appearance'
import {
  deriveNeonPalette,
  mixHexColors,
  resolveChatAppearance,
  isHexColor,
  type ChatAppearanceCorrectionField,
  type ChatAppearanceTokens,
  type ChatPalette,
} from '@pathfinder/ui/theme'

type PresetId = 'clean' | 'soft' | 'photo' | 'text'

const CORRECTION_LABELS: Record<ChatAppearanceCorrectionField, string> = {
  userTextColor: 'Visitor text colour',
  assistantTextColor: 'Guide text colour',
  headerTitleColor: 'Header title colour',
}

function presetAppearance(
  preset: PresetId,
  current: ChatAppearance,
  palette: ChatPalette,
): ChatAppearance {
  const base: ChatAppearance = {
    ...DEFAULT_CHAT_APPEARANCE,
    title: current.title,
    requestMore: current.requestMore,
    actionLinks: current.actionLinks,
    actionButtons: current.actionButtons,
    background: { ...current.background, mode: 'none' },
  }
  if (preset === 'soft') return { ...base, assistantBubble: true }
  if (preset === 'text') return { ...base, userBubble: false, assistantBubble: false }
  if (preset === 'photo') {
    // A dark frame derived from the venue accent keeps photos calm behind protected text.
    const night = deriveNeonPalette(palette.accent)
    return {
      ...base,
      headerColor: night.bg,
      assistantSurfaceColor: night.card,
      userBubbleColor: mixHexColors(palette.accent, night.bg, 0.42),
      background: {
        ...current.background,
        mode: 'image',
        dim: Math.max(current.background.dim, 35),
      },
    }
  }
  return base
}

function matchingPreset(value: ChatAppearance, palette: ChatPalette): PresetId | null {
  for (const preset of ['clean', 'soft', 'photo', 'text'] as const) {
    if (chatAppearanceEquals(presetAppearance(preset, value, palette), value)) return preset
  }
  return null
}

const PRESETS: { id: PresetId; label: string; description: string }[] = [
  { id: 'clean', label: 'Clean', description: 'Visitor bubble, open answers, no background.' },
  { id: 'soft', label: 'Soft bubbles', description: 'Both speakers in rounded bubbles.' },
  { id: 'photo', label: 'Photo backdrop', description: 'Reviewed image behind reading panels.' },
  { id: 'text', label: 'Text only', description: 'No bubbles; small You and Guide labels.' },
]

export function ChatAppearanceEditor({
  value,
  onChange,
  palette,
  fontFamily,
  venueName,
  backgroundAvailable,
  backgroundImageUrl,
  disabled = false,
}: {
  value: ChatAppearance
  onChange: (next: ChatAppearance) => void
  palette: ChatPalette
  fontFamily?: string
  venueName: string
  /** Whether a reviewed banner is selected; it is the only possible background source. */
  backgroundAvailable: boolean
  /** Where the sample can load that banner, when reachable from this page. */
  backgroundImageUrl: string | null
  disabled?: boolean
}) {
  const [imageFailed, setImageFailed] = useState<string | null>(null)
  const tokens = resolveChatAppearance(palette, value, { hasBackgroundImage: backgroundAvailable })
  const sampleImage =
    tokens.backgroundImage && backgroundImageUrl && imageFailed !== backgroundImageUrl
      ? backgroundImageUrl
      : null
  const selectedPreset = matchingPreset(value, palette)
  const set = (change: Partial<ChatAppearance>) => onChange({ ...value, ...change })
  const setBackground = (change: Partial<ChatAppearance['background']>) =>
    onChange({ ...value, background: { ...value.background, ...change } })
  const titleId = useId()
  const warningsId = useId()

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-2xl border border-pf-light bg-pf-white p-4 sm:p-5"
    >
      <h2 id={titleId} className="text-sm font-semibold text-pf-deep">
        Visitor chat style
      </h2>
      <p className="mt-1 text-xs leading-5 text-pf-deep/70">
        Start with a style, then adjust details. Text colours that would be hard to read are
        corrected automatically for visitors.
      </p>

      <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Chat style presets">
            {PRESETS.map((preset) => {
              const needsImage = preset.id === 'photo' && !backgroundAvailable
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={selectedPreset === preset.id}
                  disabled={disabled || needsImage}
                  onClick={() => onChange(presetAppearance(preset.id, value, palette))}
                  className="min-h-11 rounded-xl border border-pf-light p-3 text-left transition hover:border-pf-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-pf-primary aria-pressed:bg-pf-primary/5 motion-reduce:transition-none"
                >
                  <span className="block text-sm font-semibold text-pf-deep">{preset.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-pf-deep/65">
                    {needsImage ? 'Select a reviewed banner image first.' : preset.description}
                  </span>
                </button>
              )
            })}
          </div>

          {tokens.corrections.length ? (
            <div
              id={warningsId}
              role="status"
              className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-900"
            >
              <p className="font-semibold">Adjusted for readability</p>
              <ul className="mt-1 list-disc pl-4">
                {tokens.corrections.map((correction) => (
                  <li key={correction.field}>
                    {CORRECTION_LABELS[correction.field]} {correction.requested} has a contrast of{' '}
                    {correction.ratio}:1 on its background. Visitors will see {correction.applied}{' '}
                    instead.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <details className="group rounded-xl border border-pf-light">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-sm font-semibold text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent">
              Advanced colours and layout
              <span aria-hidden="true" className="transition group-open:rotate-180">
                ⌄
              </span>
            </summary>
            <fieldset
              className="space-y-5 border-t border-pf-light p-3"
              disabled={disabled}
              aria-describedby={tokens.corrections.length ? warningsId : undefined}
            >
              <TextField
                label="Title shown to visitors"
                help="Leave blank to use the venue name. Long titles wrap onto a second line."
                value={value.title ?? ''}
                placeholder={venueName}
                maxLength={80}
                onChange={(next) => set({ title: next.trim() ? next : null })}
              />

              <div className="space-y-1">
                <Toggle
                  label="Visitor messages in a bubble"
                  checked={value.userBubble}
                  onChange={(checked) => set({ userBubble: checked })}
                />
                <Toggle
                  label="Guide answers in a bubble"
                  checked={value.assistantBubble}
                  onChange={(checked) => set({ assistantBubble: checked })}
                />
                <Toggle
                  label="Show “Tell me more about that”"
                  checked={value.requestMore}
                  onChange={(checked) => set({ requestMore: checked })}
                />
                <Toggle
                  label="Offer official links inside answers"
                  checked={value.actionLinks ?? false}
                  onChange={(checked) => set({ actionLinks: checked })}
                />
                <Toggle
                  label="Offer one official action button"
                  checked={value.actionButtons ?? false}
                  onChange={(checked) => set({ actionButtons: checked })}
                />
                {!value.userBubble && !value.assistantBubble ? (
                  <p className="text-xs leading-5 text-pf-deep/65">
                    With both bubbles off, visitors see small “You” and “Guide” labels.
                  </p>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <ColorField
                  label="Visitor text"
                  value={value.userTextColor}
                  effective={tokens.userText}
                  onChange={(color) => set({ userTextColor: color })}
                />
                <ColorField
                  label="Visitor bubble"
                  value={value.userBubbleColor}
                  effective={tokens.userBg}
                  onChange={(color) => set({ userBubbleColor: color })}
                />
                <ColorField
                  label="Guide text"
                  value={value.assistantTextColor}
                  effective={tokens.assistantText}
                  onChange={(color) => set({ assistantTextColor: color })}
                />
                <ColorField
                  label="Guide bubble / reading panel"
                  value={value.assistantSurfaceColor}
                  effective={
                    tokens.assistantBubble || tokens.assistantProtected
                      ? tokens.assistantBg
                      : palette.card
                  }
                  onChange={(color) => set({ assistantSurfaceColor: color })}
                />
                <ColorField
                  label="Header"
                  value={value.headerColor}
                  effective={tokens.headerBg}
                  onChange={(color) => set({ headerColor: color })}
                />
                <ColorField
                  label="Header title"
                  value={value.headerTitleColor}
                  effective={tokens.headerText}
                  onChange={(color) => set({ headerTitleColor: color })}
                />
              </div>

              <div className="space-y-2">
                <Toggle
                  label="Bottom bar matches the header"
                  checked={value.footerColor === null}
                  onChange={(checked) =>
                    set({ footerColor: checked ? null : (value.headerColor ?? palette.bg) })
                  }
                />
                {value.footerColor !== null ? (
                  <ColorField
                    label="Bottom bar"
                    value={value.footerColor}
                    effective={tokens.footerBg}
                    allowDefault={false}
                    onChange={(color) => set({ footerColor: color })}
                  />
                ) : null}
              </div>

              <fieldset className="space-y-3 rounded-xl border border-pf-light p-3">
                <legend className="px-1 text-sm font-semibold text-pf-deep">
                  Background image
                </legend>
                <Toggle
                  label="Use the reviewed banner as the chat background"
                  checked={value.background.mode === 'image'}
                  disabled={!backgroundAvailable}
                  onChange={(checked) => setBackground({ mode: checked ? 'image' : 'none' })}
                />
                {!backgroundAvailable ? (
                  <p className="text-xs leading-5 text-pf-deep/65">
                    Choose a reviewed banner asset above. Only reviewed venue media can be used.
                  </p>
                ) : null}
                {value.background.mode === 'image' && backgroundAvailable ? (
                  <>
                    <Slider
                      label="Horizontal focus"
                      value={value.background.focalX}
                      min={0}
                      max={100}
                      suffix="%"
                      onChange={(focalX) => setBackground({ focalX })}
                    />
                    <Slider
                      label="Vertical focus"
                      value={value.background.focalY}
                      min={0}
                      max={100}
                      suffix="%"
                      onChange={(focalY) => setBackground({ focalY })}
                    />
                    <Slider
                      label="Dim the image"
                      value={value.background.dim}
                      min={0}
                      max={85}
                      suffix="%"
                      onChange={(dim) => setBackground({ dim })}
                    />
                    <p className="text-xs leading-5 text-pf-deep/65">
                      Answers always sit on a solid reading panel over images. If the image cannot
                      load, visitors see the plain theme.
                    </p>
                  </>
                ) : null}
              </fieldset>

              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...DEFAULT_CHAT_APPEARANCE,
                    background: { ...DEFAULT_CHAT_APPEARANCE.background },
                  })
                }
                className="min-h-11 rounded-full border border-pf-light px-4 text-sm font-semibold text-pf-deep hover:border-pf-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                Restore default style
              </button>
            </fieldset>
          </details>
        </div>

        <ChatStylePreview
          tokens={tokens}
          title={value.title ?? venueName}
          showRequestMore={value.requestMore}
          fontFamily={fontFamily}
          backgroundImageUrl={sampleImage}
          onImageError={() => setImageFailed(backgroundImageUrl)}
          palette={palette}
        />
      </div>
    </section>
  )
}

/** A compact, literal sample of the visitor chat using the same resolved tokens. */
function ChatStylePreview({
  tokens,
  title,
  showRequestMore,
  fontFamily,
  backgroundImageUrl,
  onImageError,
  palette,
}: {
  tokens: ChatAppearanceTokens
  title: string
  showRequestMore: boolean
  fontFamily: string | undefined
  backgroundImageUrl: string | null
  onImageError: () => void
  palette: ChatPalette
}) {
  const bubble = (surface: boolean, bg: string, border: string): CSSProperties =>
    surface
      ? { background: bg, border: `1px solid ${border}`, borderRadius: 16, padding: '8px 12px' }
      : {}
  return (
    <figure className="min-w-0">
      <div
        aria-hidden="true"
        className="relative flex h-[26rem] flex-col overflow-hidden rounded-[1.75rem] border border-pf-light text-[13px] shadow-sm"
        style={{ background: tokens.pageBg, fontFamily }}
      >
        <div
          className="relative z-10 flex items-center gap-2 border-b px-3 py-2.5"
          style={{
            background: tokens.headerBg,
            color: tokens.headerText,
            borderColor: tokens.headerBorder,
          }}
        >
          <span style={{ color: tokens.headerAccent }}>←</span>
          <span className="text-[15px] font-semibold leading-tight">{title}</span>
        </div>
        <div className="relative flex-1 overflow-hidden">
          {backgroundImageUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={backgroundImageUrl}
                alt=""
                onError={onImageError}
                className="absolute inset-0 h-full w-full object-cover"
                style={{ objectPosition: tokens.backgroundPosition }}
              />
              <span className="absolute inset-0" style={{ background: tokens.backgroundOverlay }} />
            </>
          ) : null}
          <div className="relative space-y-3 p-3">
            <div className="flex flex-col items-end">
              {tokens.speakerLabels ? (
                <span
                  className="mb-1 text-[11px] font-semibold"
                  style={{ color: tokens.speakerLabelColor }}
                >
                  You
                </span>
              ) : null}
              <p
                className="max-w-[85%]"
                style={{
                  color: tokens.userText,
                  ...bubble(tokens.userSurface, tokens.userBg, tokens.userBorder),
                }}
              >
                What should we see first?
              </p>
            </div>
            <div>
              {tokens.speakerLabels ? (
                <span
                  className="mb-1 block text-[11px] font-semibold"
                  style={{ color: tokens.speakerLabelColor }}
                >
                  Guide
                </span>
              ) : null}
              <p
                className="leading-relaxed"
                style={{
                  color: tokens.assistantText,
                  ...bubble(
                    tokens.assistantBubble || tokens.assistantProtected,
                    tokens.assistantBg,
                    tokens.assistantBorder,
                  ),
                }}
              >
                Start with the main gallery near the entrance. It takes about twenty minutes.
              </p>
            </div>
            {showRequestMore ? (
              <span
                className="inline-flex rounded-full border px-3 py-1.5 text-[12px] font-semibold"
                style={{
                  background: tokens.actionBg,
                  color: tokens.actionText,
                  borderColor: tokens.actionBorder,
                }}
              >
                Tell me more about that
              </span>
            ) : null}
          </div>
        </div>
        <div
          className="relative z-10 border-t px-3 pb-1.5 pt-2"
          style={{ background: tokens.footerBg, borderColor: tokens.footerBorder }}
        >
          <div
            className="flex items-center justify-between rounded-2xl border px-3 py-2"
            style={{
              background: tokens.fieldBg,
              borderColor: tokens.fieldBorder,
              color: tokens.fieldMuted,
            }}
          >
            Ask about this place
            <span
              className="grid h-6 w-6 place-items-center rounded-full text-[11px]"
              style={{ background: palette.accent, color: palette.accentContrast }}
            >
              ↑
            </span>
          </div>
          <p className="mt-1.5 text-center text-[10px]" style={{ color: tokens.footerMuted }}>
            AI guide ·{' '}
            <span style={{ color: tokens.footerText, textDecoration: 'underline' }}>Settings</span>
          </p>
        </div>
      </div>
      <figcaption className="mt-2 text-xs leading-5 text-pf-deep/65">
        Live sample of the visitor chat with these settings.
      </figcaption>
    </figure>
  )
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm text-pf-deep">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

function TextField({
  label,
  help,
  value,
  placeholder,
  maxLength,
  onChange,
}: {
  label: string
  help: string
  value: string
  placeholder: string
  maxLength: number
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-pf-deep">
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-describedby={`${id}-help`}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-pf-white px-3 text-sm text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
      />
      <p id={`${id}-help`} className="mt-1 text-xs leading-5 text-pf-deep/65">
        {help}
      </p>
    </div>
  )
}

function ColorField({
  label,
  value,
  effective,
  allowDefault = true,
  onChange,
}: {
  label: string
  value: string | null
  effective: string
  allowDefault?: boolean
  onChange: (value: string | null) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value ?? ''
  const invalid = shown !== '' && !isHexColor(shown)
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-semibold text-pf-deep">
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={(value ?? effective).toLowerCase()}
          onChange={(event) => {
            setDraft(null)
            onChange(event.target.value.toUpperCase())
          }}
          className="h-11 w-11 flex-shrink-0 cursor-pointer rounded-lg border border-pf-light bg-pf-white p-1"
        />
        <input
          id={id}
          value={shown}
          placeholder={allowDefault ? `Theme ${effective}` : effective}
          maxLength={7}
          aria-invalid={invalid}
          onChange={(event) => {
            const next = event.target.value.trim()
            setDraft(next)
            if (next === '' && allowDefault) onChange(null)
            else if (isHexColor(next)) onChange(next.toUpperCase())
          }}
          onBlur={() => setDraft(null)}
          className="min-h-11 w-full min-w-0 rounded-xl border border-pf-light bg-pf-white px-3 font-mono text-sm text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent aria-[invalid=true]:border-rose-400"
        />
      </div>
      {allowDefault && value !== null ? (
        <button
          type="button"
          onClick={() => {
            setDraft(null)
            onChange(null)
          }}
          className="mt-1 min-h-11 text-xs font-semibold text-pf-primary underline-offset-2 hover:underline"
        >
          Use theme default
        </button>
      ) : null}
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  suffix: string
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <div>
      <div className="flex items-center justify-between text-xs font-semibold text-pf-deep">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {value}
          {suffix}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 h-11 w-full accent-pf-primary"
      />
    </div>
  )
}
