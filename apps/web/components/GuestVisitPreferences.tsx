'use client'

import { useEffect, useMemo, useState } from 'react'
import type { GuestVisitContextInput } from '@pathfinder/contracts/guest-visit-context'

const MAX_INTERESTS = 5
const MAX_INTEREST_LENGTH = 80
const MAX_REMAINING_MINUTES = 600

type Draft = { visitedPlaceIds: string[]; interests: string; remainingMinutes: string }
type PlaceOption = { id: string; name: string }

function draftFromContext(context: GuestVisitContextInput): Draft {
  return {
    visitedPlaceIds: [...context.visitedPlaceIds],
    interests: context.interests.join(', '),
    remainingMinutes: context.remainingMinutes == null ? '' : String(context.remainingMinutes),
  }
}

export function GuestVisitPreferences({
  context,
  places = [],
  onChange,
  onFreshVisit,
  disabled = false,
}: {
  context: GuestVisitContextInput
  places?: ReadonlyArray<PlaceOption>
  onChange: (next: GuestVisitContextInput) => boolean
  onFreshVisit: () => void
  disabled?: boolean
}) {
  const contextKey = useMemo(() => JSON.stringify(context), [context])
  const contextDraft = useMemo(
    () => draftFromContext(JSON.parse(contextKey) as GuestVisitContextInput),
    [contextKey],
  )
  const [draft, setDraft] = useState(() => draftFromContext(context))
  const [errors, setErrors] = useState<string[]>([])
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const visiblePlaces = useMemo(() => {
    const seen = new Set<string>()
    return places
      .filter((place) => {
        const id = place.id.trim()
        const name = place.name.trim()
        if (!id || !name || seen.has(id)) return false
        seen.add(id)
        return true
      })
      .slice(0, 20)
  }, [places])

  useEffect(() => {
    setDraft(contextDraft)
    setErrors([])
    setSavedMessage(null)
  }, [contextDraft, contextKey])

  function save() {
    const interests = draft.interests
      .split(',')
      .map((interest) => interest.trim())
      .filter(Boolean)
    const nextErrors: string[] = []
    if (interests.length > MAX_INTERESTS) {
      nextErrors.push(`Add up to ${MAX_INTERESTS} interests.`)
    }
    if (interests.some((interest) => interest.length > MAX_INTEREST_LENGTH)) {
      nextErrors.push(`Each interest must be ${MAX_INTEREST_LENGTH} characters or fewer.`)
    }
    if (draft.visitedPlaceIds.length > 20) {
      nextErrors.push('You can mark up to 20 visited places.')
    }

    const minutesText = draft.remainingMinutes.trim()
    let remainingMinutes: number | null = null
    if (minutesText) {
      const parsed = Number(minutesText)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REMAINING_MINUTES) {
        nextErrors.push(`Remaining time must be a whole number from 1 to ${MAX_REMAINING_MINUTES}.`)
      } else {
        remainingMinutes = parsed
      }
    }
    if (nextErrors.length > 0) {
      setErrors(nextErrors)
      setSavedMessage(null)
      return
    }

    const next: GuestVisitContextInput = {
      visitedPlaceIds: draft.visitedPlaceIds,
      interests,
      remainingMinutes,
    }
    if (!onChange(next)) {
      setErrors(['Your visit preferences could not be saved. Try again.'])
      setSavedMessage(null)
      return
    }
    setErrors([])
    setSavedMessage('Your visit preferences are saved for this page.')
  }

  return (
    <details className="rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] text-[var(--chat-text)] shadow-sm">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chat-accent)] focus-visible:ring-inset">
        <span className="inline-flex items-center gap-2">
          Your visit <span aria-hidden="true">⌄</span>
        </span>
      </summary>
      <div className="border-t border-[var(--chat-border)] px-4 pb-4 pt-3">
        <p className="text-sm leading-6 text-[var(--chat-text-muted)]">
          Add a few things you want to see and how much time you have. These preferences last only
          while this page stays open. Clearing chat keeps them.
        </p>
        {context.visitedPlaceIds.length > 0 ? (
          <p className="mt-3 text-xs text-[var(--chat-text-muted)]">
            Explicitly visited places:{' '}
            <span className="font-semibold text-[var(--chat-text)]">
              {context.visitedPlaceIds.length}
            </span>
          </p>
        ) : null}
        {visiblePlaces.length > 0 ? (
          <fieldset className="mt-4">
            <legend className="text-xs font-medium text-[var(--chat-text-muted)]">
              I have visited
            </legend>
            <div className="mt-2 space-y-2">
              {visiblePlaces.map((place) => (
                <label
                  key={place.id}
                  className="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--chat-border)] bg-[var(--chat-surface)] px-3 py-2 text-sm text-[var(--chat-text)]"
                >
                  <input
                    type="checkbox"
                    checked={draft.visitedPlaceIds.includes(place.id)}
                    disabled={disabled}
                    onChange={(event) => {
                      setErrors([])
                      setDraft((current) => {
                        if (event.target.checked) {
                          if (current.visitedPlaceIds.includes(place.id)) return current
                          if (current.visitedPlaceIds.length >= 20) {
                            setErrors(['You can mark up to 20 visited places.'])
                            return current
                          }
                          return {
                            ...current,
                            visitedPlaceIds: [...current.visitedPlaceIds, place.id],
                          }
                        }
                        return {
                          ...current,
                          visitedPlaceIds: current.visitedPlaceIds.filter((id) => id !== place.id),
                        }
                      })
                    }}
                    className="h-5 w-5 shrink-0 accent-[var(--chat-accent)]"
                  />
                  <span>{place.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <label
          htmlFor="visit-interests"
          className="mt-4 block text-xs font-medium text-[var(--chat-text-muted)]"
        >
          Interests <span aria-hidden="true">·</span> up to {MAX_INTERESTS}, separated by commas
        </label>
        <input
          id="visit-interests"
          value={draft.interests}
          onChange={(event) =>
            setDraft((current) => ({ ...current, interests: event.target.value }))
          }
          disabled={disabled}
          placeholder="trains, local history"
          className="mt-1 min-h-11 w-full rounded-xl border border-[var(--chat-border)] bg-[var(--chat-surface)] px-3 text-[16px] text-[var(--chat-text)] outline-none focus:border-[var(--chat-accent)] focus:ring-2 focus:ring-[var(--chat-accent)]/20 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <label
          htmlFor="visit-time"
          className="mt-4 block text-xs font-medium text-[var(--chat-text-muted)]"
        >
          Time left <span className="font-normal">(optional, minutes)</span>
        </label>
        <input
          id="visit-time"
          inputMode="numeric"
          value={draft.remainingMinutes}
          onChange={(event) =>
            setDraft((current) => ({ ...current, remainingMinutes: event.target.value }))
          }
          disabled={disabled}
          placeholder="45"
          className="mt-1 min-h-11 w-full rounded-xl border border-[var(--chat-border)] bg-[var(--chat-surface)] px-3 text-[16px] text-[var(--chat-text)] outline-none focus:border-[var(--chat-accent)] focus:ring-2 focus:ring-[var(--chat-accent)]/20 disabled:cursor-not-allowed disabled:opacity-60"
        />
        {errors.length > 0 ? (
          <div role="alert" className="mt-3 space-y-1 text-sm text-[var(--chat-text)]">
            {errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}
        {savedMessage ? (
          <p role="status" className="mt-3 text-sm text-[var(--chat-text-muted)]">
            {savedMessage}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={save}
            disabled={disabled}
            className="min-h-11 rounded-xl bg-[var(--chat-accent)] px-4 text-sm font-semibold text-[var(--chat-accent-contrast)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save preferences
          </button>
          <button
            type="button"
            onClick={onFreshVisit}
            disabled={disabled}
            className="min-h-11 rounded-xl border border-[var(--chat-border)] px-4 text-sm font-semibold text-[var(--chat-accent-text)] transition hover:border-[var(--chat-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Start a fresh visit
          </button>
        </div>
        <p className="mt-3 text-xs leading-5 text-[var(--chat-text-muted)]">
          A fresh visit clears chat and visit preferences together.
        </p>
      </div>
    </details>
  )
}
