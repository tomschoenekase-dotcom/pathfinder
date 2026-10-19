// Record dates in the visitor prompt. Two records can disagree (an old and a new price page),
// and without dates the model cannot tell which is current, so it mixes them or guesses. When
// GUEST_CHAT_RECORD_DATES=on, each knowledge topic shows the date it was last updated and one
// rule says how to use it. Off by default; it changes the cached prompt prefix for every model.

export const GUEST_RECORD_DATES_VERSION = 'guest-record-dates-v1'

export const GUEST_RECORD_DATE_RULE =
  'Each topic shows the date its record was last updated. When two topics disagree about the same thing, use the more recently updated one unless its own text says it applies to another period; never combine their figures, and say staff can confirm when the difference matters.'

export function guestRecordDatesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GUEST_CHAT_RECORD_DATES?.trim().toLowerCase() === 'on'
}

/** The record's last update as YYYY-MM-DD, or null when the date is missing or invalid. */
export function guestRecordDate(updatedAt: Date | string | null | undefined): string | null {
  if (!updatedAt) return null
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null
}
