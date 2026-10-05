'use client'

import { useId, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import {
  GUEST_ACTION_LIMIT,
  GuestActionDefinition,
  isApprovedGuestActionUrl,
  type GuestActionType,
} from '@pathfinder/contracts/guest-action-links'

import { portalButtonSecondary, portalInput, portalTextLink } from './PortalPrimitives'

export type GuestActionDraft = {
  id: string
  label: string
  url: string
  actionType: GuestActionType
  placeId: string | null
  provider: string | null
  enabled: boolean
  conditions: string | null
  availableFrom: string | null
  availableUntil: string | null
}

const ACTION_TYPES: Array<{ value: GuestActionType; label: string }> = [
  { value: 'ORDER_AHEAD', label: 'Mobile order' },
  { value: 'BUY_TICKETS', label: 'Tickets' },
  { value: 'BUY_PASS', label: 'Season or annual pass' },
  { value: 'BOOK_EXPERIENCE', label: 'Book an experience' },
  { value: 'RESERVE', label: 'Reservation' },
  { value: 'OTHER', label: 'Other' },
]

function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 50) || 'action'
  )
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let candidate = slug(base)
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${slug(base)}-${suffix}`
  return candidate
}

/** Valid stored actions only; anything malformed is left out of the editor. */
export function guestActionDrafts(stored: readonly unknown[]): GuestActionDraft[] {
  return stored.flatMap((raw) => {
    const parsed = GuestActionDefinition.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  })
}

/**
 * Parses pasted JSON (for example the `guestActions` list from a venue import file). Entries may
 * name their place with `placeName` instead of `placeId`; names are matched exactly.
 */
export function importGuestActions(
  text: string,
  places: ReadonlyArray<{ id: string; name: string }>,
  existing: readonly GuestActionDraft[],
): { actions: GuestActionDraft[]; error: string | null } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { actions: [], error: 'This isn’t valid JSON.' }
  }
  const list = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as { guestActions?: unknown }).guestActions)
      ? (raw as { guestActions: unknown[] }).guestActions
      : null
  if (!list) return { actions: [], error: 'Paste a list of actions.' }
  const byName = new Map(places.map((place) => [place.name.trim().toLowerCase(), place.id]))
  const taken = new Set(existing.map((action) => action.id))
  const actions: GuestActionDraft[] = []
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object')
      return { actions: [], error: `Item ${index + 1} isn’t an action.` }
    const { placeName, ...rest } = entry as Record<string, unknown>
    let placeId = (rest.placeId as string | null | undefined) ?? null
    if (typeof placeName === 'string' && placeName.trim()) {
      placeId = byName.get(placeName.trim().toLowerCase()) ?? null
      if (!placeId)
        return { actions: [], error: `Item ${index + 1}: no place is named “${placeName}”.` }
    }
    const id =
      typeof rest.id === 'string' && rest.id && !taken.has(rest.id)
        ? rest.id
        : uniqueId(String(rest.label ?? 'action'), taken)
    const parsed = GuestActionDefinition.safeParse({ ...rest, id, placeId })
    if (!parsed.success)
      return {
        actions: [],
        error: `Item ${index + 1}: ${parsed.error.issues[0]?.message ?? 'invalid action'}.`,
      }
    taken.add(parsed.data.id)
    actions.push(parsed.data)
  }
  return { actions, error: null }
}

type Props = {
  actions: GuestActionDraft[]
  places: ReadonlyArray<{ id: string; name: string }>
  inlineLinks: boolean
  buttons: boolean
  canEdit: boolean
  onSettings: (change: { actionLinks?: boolean; actionButtons?: boolean }) => void
  onChange: (actions: GuestActionDraft[]) => void
}

export function GuestActionsEditor({
  actions,
  places,
  inlineLinks,
  buttons,
  canEdit,
  onSettings,
  onChange,
}: Props) {
  const baseId = useId()
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const update = (index: number, change: Partial<GuestActionDraft>) =>
    onChange(actions.map((action, at) => (at === index ? { ...action, ...change } : action)))

  function add() {
    const taken = new Set(actions.map((action) => action.id))
    onChange([
      ...actions,
      {
        id: uniqueId('action', taken),
        label: '',
        url: '',
        actionType: 'ORDER_AHEAD',
        placeId: null,
        provider: null,
        enabled: true,
        conditions: null,
        availableFrom: null,
        availableUntil: null,
      },
    ])
  }

  function runImport() {
    const result = importGuestActions(importText, places, actions)
    setImportError(result.error)
    if (result.error) return
    onChange([...actions, ...result.actions].slice(0, GUEST_ACTION_LIMIT))
    setImportText('')
  }

  return (
    <div className="space-y-4">
      <fieldset disabled={!canEdit} className="space-y-1">
        <legend className="text-sm font-semibold">How the guide may offer them</legend>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={inlineLinks}
            onChange={(event) => onSettings({ actionLinks: event.currentTarget.checked })}
          />
          Links inside answers, such as “you can order ahead”
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={buttons}
            onChange={(event) => onSettings({ actionButtons: event.currentTarget.checked })}
          />
          One button when the visitor wants to buy or book
        </label>
        {!inlineLinks && !buttons ? (
          <p className="text-xs leading-5 text-tk-soft">
            Both are off, so the guide answers questions without offering these links.
          </p>
        ) : null}
      </fieldset>

      {actions.length ? (
        <ul className="space-y-3">
          {actions.map((action, index) => {
            const rowId = `${baseId}-${index}`
            const badUrl = action.url.trim() !== '' && !isApprovedGuestActionUrl(action.url.trim())
            return (
              <li key={action.id} className="rounded-lg border border-tk-rule bg-white p-4">
                <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
                  <legend className="sr-only">{action.label || 'New action'}</legend>
                  <label className="text-sm" htmlFor={`${rowId}-label`}>
                    Button or link text
                    <input
                      id={`${rowId}-label`}
                      className={`${portalInput} mt-1`}
                      value={action.label}
                      maxLength={60}
                      placeholder="Order ahead"
                      onChange={(event) => update(index, { label: event.currentTarget.value })}
                    />
                  </label>
                  <label className="text-sm" htmlFor={`${rowId}-type`}>
                    Kind
                    <select
                      id={`${rowId}-type`}
                      className={`${portalInput} mt-1`}
                      value={action.actionType}
                      onChange={(event) =>
                        update(index, {
                          actionType: event.currentTarget.value as GuestActionType,
                        })
                      }
                    >
                      {ACTION_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm sm:col-span-2" htmlFor={`${rowId}-url`}>
                    Official link
                    <input
                      id={`${rowId}-url`}
                      type="url"
                      inputMode="url"
                      className={`${portalInput} mt-1`}
                      value={action.url}
                      placeholder="https://"
                      aria-invalid={badUrl}
                      aria-describedby={badUrl ? `${rowId}-url-error` : undefined}
                      onChange={(event) => update(index, { url: event.currentTarget.value })}
                    />
                    {badUrl ? (
                      <span id={`${rowId}-url-error`} className="mt-1 block text-xs text-tk-danger">
                        Use the full https:// link from your ordering or ticketing provider, without
                        passwords or access keys.
                      </span>
                    ) : null}
                  </label>
                  <label className="text-sm" htmlFor={`${rowId}-place`}>
                    For
                    <select
                      id={`${rowId}-place`}
                      className={`${portalInput} mt-1`}
                      value={action.placeId ?? ''}
                      onChange={(event) =>
                        update(index, { placeId: event.currentTarget.value || null })
                      }
                    >
                      <option value="">The whole venue</option>
                      {places.map((place) => (
                        <option key={place.id} value={place.id}>
                          {place.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm" htmlFor={`${rowId}-provider`}>
                    Provider (optional)
                    <input
                      id={`${rowId}-provider`}
                      className={`${portalInput} mt-1`}
                      value={action.provider ?? ''}
                      maxLength={80}
                      placeholder="Toast, Square, Ticketmaster…"
                      onChange={(event) =>
                        update(index, { provider: event.currentTarget.value || null })
                      }
                    />
                  </label>
                  <label className="text-sm sm:col-span-2" htmlFor={`${rowId}-conditions`}>
                    When to offer it (optional)
                    <input
                      id={`${rowId}-conditions`}
                      className={`${portalInput} mt-1`}
                      value={action.conditions ?? ''}
                      maxLength={300}
                      placeholder="Mobile ordering runs 11am–8pm"
                      onChange={(event) =>
                        update(index, { conditions: event.currentTarget.value || null })
                      }
                    />
                  </label>
                  <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
                    <label className="flex min-h-11 items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={action.enabled}
                        onChange={(event) =>
                          update(index, { enabled: event.currentTarget.checked })
                        }
                      />
                      Offer to visitors
                    </label>
                    <button
                      type="button"
                      className={portalButtonSecondary}
                      onClick={() => onChange(actions.filter((_, at) => at !== index))}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
                    </button>
                  </div>
                </fieldset>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-sm text-tk-soft">No official links yet.</p>
      )}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={portalButtonSecondary}
            disabled={actions.length >= GUEST_ACTION_LIMIT}
            onClick={add}
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add a link
          </button>
          {actions.length ? (
            <button
              type="button"
              className={portalTextLink}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(JSON.stringify(actions, null, 2))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }}
            >
              {copied ? 'Copied' : 'Copy as JSON'}
            </button>
          ) : null}
        </div>
      ) : null}

      {canEdit ? (
        <details className="rounded-lg border border-tk-rule bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Add from a venue import
          </summary>
          <p className="mt-2 text-xs leading-5 text-tk-soft">
            Paste the <code>guestActions</code> list from an import file. Each item needs a label,
            url and actionType, and can name its place with placeName.
          </p>
          <label className="sr-only" htmlFor={`${baseId}-import`}>
            Actions JSON
          </label>
          <textarea
            id={`${baseId}-import`}
            className={`${portalInput} mt-2 min-h-28 py-2 font-mono text-xs`}
            value={importText}
            onChange={(event) => {
              setImportText(event.currentTarget.value)
              setImportError(null)
            }}
          />
          {importError ? (
            <p role="alert" className="mt-2 text-xs text-tk-danger">
              {importError}
            </p>
          ) : null}
          <button
            type="button"
            className={`${portalButtonSecondary} mt-2`}
            disabled={!importText.trim()}
            onClick={runImport}
          >
            Add these links
          </button>
        </details>
      ) : null}
    </div>
  )
}
