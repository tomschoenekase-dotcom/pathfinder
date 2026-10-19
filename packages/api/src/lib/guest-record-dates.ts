// Record dates in the visitor prompt. Two records can disagree (an old and a new price page),
// and without dates the model cannot tell which is current, so it mixes them or guesses. When
// GUEST_CHAT_RECORD_DATES=on, each knowledge topic shows the date it was last updated and one
// rule says how to use it. Off by default; it changes the cached prompt prefix for every model.
// updatedAt also moves when a record is only reviewed or re-imported without a content change,
// so this stays off until a content-change timestamp backs it (see cycle02 REVIEW-PRODUCT-03).

export const GUEST_RECORD_DATES_VERSION = 'guest-record-dates-v2'

export const GUEST_RECORD_DATE_RULE =
  'Topics that show an updated date give the date their record was last edited; it is for your judgement only, so never mention it to the visitor. Records that cover different people, ticket types, days, areas or periods do not conflict: use the one that fits the question. Only when two records give different values for exactly the same thing, prefer the later-edited one, never combine or average their figures, and suggest confirming with staff when the difference matters.'

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
