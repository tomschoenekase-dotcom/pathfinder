'use client'

import { useId } from 'react'
import { Check } from 'lucide-react'

import { chatContrastRatio } from '@pathfinder/ui/theme'

const COLOR_NAMES: Record<string, string> = {
  '#FFFFFF': 'White',
  '#F1ECE2': 'Sand',
  '#DCE8F2': 'Mist blue',
  '#DDEBE3': 'Sage',
  '#F4DDD4': 'Blush',
  '#1F3A5F': 'Navy',
  '#2D6A4F': 'Forest',
  '#6B4C7A': 'Plum',
  '#102F50': 'Ink',
  '#1C1C1C': 'Charcoal',
  '#6B3A1F': 'Walnut',
}

function markColor(fill: string) {
  return chatContrastRatio('#FFFFFF', fill) >= chatContrastRatio('#102F50', fill)
    ? '#FFFFFF'
    : '#102F50'
}

/** One small, labelled row of swatches: Default, a few calm choices, or any custom colour. */
export function ColorChoice({
  label,
  value,
  automatic,
  swatches,
  onChange,
  note,
}: {
  label: string
  value: string | null
  /** What "Default" resolves to for visitors right now. */
  automatic: string
  swatches: string[]
  onChange: (value: string | null) => void
  note?: string | null
}) {
  const name = useId()
  const labelId = `${name}-label`
  const noteId = `${name}-note`
  const normalized = value?.toUpperCase() ?? null
  const custom = normalized !== null && !swatches.includes(normalized)
  const options: Array<{ value: string | null; fill: string; title: string }> = [
    { value: null, fill: automatic, title: 'Default' },
    ...swatches.map((swatch) => ({
      value: swatch,
      fill: swatch,
      title: COLOR_NAMES[swatch] ?? swatch,
    })),
  ]
  return (
    <div>
      <div className="flex flex-col gap-1.5 min-[480px]:flex-row min-[480px]:items-center min-[480px]:gap-3">
        <span id={labelId} className="w-11 shrink-0 text-sm text-tk-soft">
          {label}
        </span>
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-describedby={note ? noteId : undefined}
          className="flex min-w-0 flex-wrap items-center gap-0.5"
        >
          {options.map((option) => {
            const selected = option.value === normalized
            if (option.value === null) {
              return (
                <label
                  key="default"
                  title={`Automatic (${automatic.toUpperCase()})`}
                  className={`mr-1 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[0.8rem] font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tk-focus ${
                    selected
                      ? 'border-tk-ink bg-tk-ink-wash text-tk-ink'
                      : 'border-tk-rule-strong/60 text-tk-soft hover:border-tk-ink'
                  }`}
                >
                  <input
                    type="radio"
                    name={name}
                    className="sr-only"
                    checked={selected}
                    aria-label="Automatic colour"
                    onChange={() => onChange(null)}
                  />
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 rounded-full border border-tk-ink/20"
                    style={{ backgroundColor: automatic }}
                  />
                  Auto
                </label>
              )
            }
            return (
              <label
                key={option.value}
                title={option.title}
                className="relative flex h-9 w-[34px] cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tk-focus"
              >
                <input
                  type="radio"
                  name={name}
                  className="sr-only"
                  checked={selected}
                  aria-label={option.title}
                  onChange={() => onChange(option.value)}
                />
                <span
                  aria-hidden="true"
                  className={`flex h-7 w-7 items-center justify-center rounded-full border ${
                    selected
                      ? 'border-tk-ink ring-2 ring-tk-ink ring-offset-2 ring-offset-tk-card'
                      : 'border-tk-ink/20'
                  }`}
                  style={{ backgroundColor: option.fill }}
                >
                  {selected ? (
                    <Check className="h-3.5 w-3.5" style={{ color: markColor(option.fill) }} />
                  ) : null}
                </span>
              </label>
            )
          })}
          <label
            title="Custom colour"
            className="relative flex h-9 w-[34px] cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tk-focus"
          >
            <input
              type="color"
              aria-label={`Custom ${label.toLowerCase()} colour`}
              value={custom ? normalized!.toLowerCase() : (normalized ?? automatic).toLowerCase()}
              onChange={(event) => onChange(event.currentTarget.value.toUpperCase())}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
            <span
              aria-hidden="true"
              className={`h-7 w-7 rounded-full border ${
                custom
                  ? 'border-tk-ink ring-2 ring-tk-ink ring-offset-2 ring-offset-tk-card'
                  : 'border-tk-ink/20'
              }`}
              style={{
                background: custom
                  ? normalized!
                  : 'conic-gradient(#d4553a, #e8b04a, #5e9c76, #3a7bd5, #6b4c7a, #d4553a)',
              }}
            />
          </label>
        </div>
      </div>
      {note ? (
        <p id={noteId} className="mt-1 text-[0.8rem] leading-5 text-tk-soft min-[480px]:pl-14">
          {note}
        </p>
      ) : null}
    </div>
  )
}
