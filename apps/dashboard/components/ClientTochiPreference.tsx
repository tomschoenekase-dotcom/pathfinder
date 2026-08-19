'use client'

import { useEffect, useState } from 'react'

export function ClientTochiPreference({
  initialEnabled,
  available,
  onChange,
}: {
  initialEnabled: boolean
  available: boolean
  onChange: (enabled: boolean) => Promise<void>
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => setEnabled(initialEnabled), [initialEnabled])

  async function save(nextEnabled: boolean) {
    setSaving(true)
    setMessage(null)
    try {
      await onChange(nextEnabled)
      setEnabled(nextEnabled)
      setMessage(nextEnabled ? 'Tochi assistance is on.' : 'Tochi assistance is off.')
    } catch {
      setMessage('That preference was not saved. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      aria-labelledby="tochi-assistance-heading"
      className="border-t border-pf-primary/10 pt-6"
    >
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="max-w-xl">
          <h2 id="tochi-assistance-heading" className="text-lg font-semibold text-pf-deep">
            Tochi assistance
          </h2>
          <p className="mt-1 text-sm leading-6 text-pf-deep/70">
            Optional private portal guidance. Turning this off never removes normal navigation,
            uploads, settings, or Help & changes.
          </p>
          {!available ? (
            <p className="mt-2 text-sm font-medium text-pf-deep/70">
              This assistance is not enabled for your organization yet.
            </p>
          ) : null}
        </div>
        <div
          className="inline-flex w-fit border border-pf-deep/20 bg-white p-1"
          role="group"
          aria-label="Tochi assistance"
        >
          {([true, false] as const).map((value) => (
            <button
              key={String(value)}
              type="button"
              aria-pressed={enabled === value}
              disabled={!available || saving}
              onClick={() => void save(value)}
              className={[
                'min-h-11 min-w-16 px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent disabled:cursor-not-allowed disabled:opacity-50',
                enabled === value ? 'bg-pf-deep text-white' : 'bg-transparent text-pf-deep',
              ].join(' ')}
            >
              {value ? 'On' : 'Off'}
            </button>
          ))}
        </div>
      </div>
      {message ? (
        <p className="mt-3 text-sm text-pf-deep/75" role="status">
          {message}
        </p>
      ) : null}
    </section>
  )
}
