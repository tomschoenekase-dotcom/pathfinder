'use client'

import { Lock } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { CANCELLED_TEXT, errorText, useOperatorPost } from './useOperatorPost'
import type { OperatorAutonomyRow } from './types'

const COPY: Record<string, { label: string; detail: string }> = {
  'crm:propose': {
    label: 'CRM changes',
    detail: 'Outreach drafts, campaign membership and stage changes.',
  },
  'crm:log': { label: 'Outreach log', detail: 'Recording that an email was sent.' },
  'venues:propose': {
    label: 'Venue setup',
    detail: 'Creating venues, adding sources and knowledge, publishing.',
  },
  'appearance:propose': { label: 'Chat appearance', detail: 'Theme, accent colour and font.' },
  'support:propose': {
    label: 'Support triage',
    detail: 'Changing the status of support requests.',
  },
  'customers:propose': {
    label: 'Customer setup',
    detail: 'Onboarding question proposals always ask for review.',
  },
  'operator:revert': { label: 'Undo', detail: 'Undoing an applied change always asks.' },
  'operator:plan': {
    label: 'Plans',
    detail: 'A plan applies on its own only when every step in it is set to act without asking.',
  },
}

type Mode = 'ask' | 'auto'

/**
 * One switch per capability. Locked rows cannot be switched (the server refuses them too).
 * Saving sends only the changes and needs Face ID or a passkey.
 */
export function OperatorAutonomy({ rows }: { rows: readonly OperatorAutonomyRow[] }) {
  const save = useOperatorPost('/api/operator/autonomy')
  const router = useRouter()
  const [draft, setDraft] = useState<Record<string, Mode>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const current = (row: OperatorAutonomyRow): Mode => draft[row.capability] ?? row.mode
  const changes = rows.flatMap((row) =>
    !row.locked && current(row) !== row.mode
      ? [{ capability: row.capability, mode: current(row) }]
      : [],
  )
  const autoCount = rows.filter((row) => current(row) === 'auto').length

  async function submit() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await save({ changes })
      if (typeof result?.saved === 'number') {
        setMessage(`Saved ${result.saved} change${result.saved === 1 ? '' : 's'}.`)
        setDraft({})
        router.refresh()
      } else {
        setMessage(errorText(result?.error))
      }
    } catch {
      setMessage(CANCELLED_TEXT)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="autonomy-heading"
      className="rounded-xl border border-slate-200 bg-white"
    >
      <div className="border-b border-slate-200 p-4 sm:p-5">
        <h2 id="autonomy-heading" className="text-lg font-semibold text-slate-950">
          Who approves what
        </h2>
        <p className="mt-1 max-w-prose text-sm text-slate-700">
          <strong>Ask first</strong> means the Dot proposes and you approve.{' '}
          <strong>Acts without asking</strong> means it applies at once and you can undo it
          afterwards. Everything starts on ask first. The Dot cannot change these switches.
        </p>
      </div>
      <ul className="divide-y divide-slate-200">
        {rows.map((row) => {
          const copy = COPY[row.capability] ?? { label: row.capability, detail: '' }
          const auto = current(row) === 'auto'
          return (
            <li key={row.capability} className="flex items-start justify-between gap-4 p-4 sm:px-5">
              <div className="min-w-0">
                <p id={`cap-${row.capability}`} className="text-base font-semibold text-slate-950">
                  {copy.label}
                </p>
                <p id={`cap-${row.capability}-detail`} className="mt-0.5 text-sm text-slate-700">
                  {copy.detail}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <button
                  type="button"
                  role="switch"
                  aria-checked={auto}
                  aria-labelledby={`cap-${row.capability}`}
                  aria-describedby={`cap-${row.capability}-detail`}
                  disabled={row.locked || busy}
                  onClick={() =>
                    setDraft((previous) => ({
                      ...previous,
                      [row.capability]: auto ? 'ask' : 'auto',
                    }))
                  }
                  className={[
                    'relative inline-flex h-8 w-14 items-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
                    auto ? 'border-orange-800 bg-orange-800' : 'border-slate-500 bg-slate-200',
                  ].join(' ')}
                >
                  <span
                    aria-hidden="true"
                    className={[
                      'inline-block h-6 w-6 rounded-full bg-white shadow transition-transform',
                      auto ? 'translate-x-7' : 'translate-x-1',
                    ].join(' ')}
                  />
                </button>
                <span className="flex items-center gap-1 text-xs font-semibold text-slate-800">
                  {row.locked ? <Lock className="h-3 w-3" aria-hidden="true" /> : null}
                  {row.locked ? 'Always asks' : auto ? 'Acts without asking' : 'Ask first'}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 p-4 sm:px-5">
        <button
          type="button"
          disabled={busy || changes.length === 0}
          onClick={() => void submit()}
          className="min-h-11 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {changes.length
            ? `Save ${changes.length} change${changes.length === 1 ? '' : 's'}`
            : 'Save changes'}
        </button>
        <button
          type="button"
          disabled={busy || Object.keys(draft).length === 0}
          onClick={() => setDraft({})}
          className="min-h-11 rounded-xl border border-slate-400 px-4 text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50"
        >
          Discard
        </button>
        <p className="text-sm text-slate-700">
          {autoCount} of {rows.length} act without asking. Saving asks for Face ID or your passkey.
        </p>
        <p role="status" className="w-full text-sm font-medium text-slate-900">
          {message}
        </p>
      </div>
    </section>
  )
}
