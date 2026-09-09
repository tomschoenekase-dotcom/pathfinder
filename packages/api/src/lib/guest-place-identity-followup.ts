import {
  guestPlaceIdentityKey,
  isExplicitGuestPlaceNonIdentityRequest,
} from './guest-place-identity'

export type GuestPlaceIdentityFollowupCandidate = {
  id: string
  name: string
  floor: string | null
  location: string | null
}

/**
 * The caller must supply the current authorized candidate universe after applying
 * the native guest-read overlay. Stored pending labels are selectors only; they
 * are never treated as current location facts or as an authorization grant.
 */
export type GuestPlaceIdentityPendingFollowup = {
  requestedName: string
  candidates: ReadonlyArray<GuestPlaceIdentityFollowupCandidate>
}

function sameIdentity(
  pending: GuestPlaceIdentityPendingFollowup['candidates'][number],
  current: GuestPlaceIdentityFollowupCandidate,
): boolean {
  return (
    pending.id === current.id &&
    guestPlaceIdentityKey(pending.name) === guestPlaceIdentityKey(current.name) &&
    guestPlaceIdentityKey(pending.floor ?? '') === guestPlaceIdentityKey(current.floor ?? '') &&
    guestPlaceIdentityKey(pending.location ?? '') === guestPlaceIdentityKey(current.location ?? '')
  )
}

function locationLabels(candidate: GuestPlaceIdentityFollowupCandidate): string[] {
  const location = guestPlaceIdentityKey(candidate.location ?? '')
  const floor = guestPlaceIdentityKey(candidate.floor ?? '')
  if (!location) return floor ? [floor] : []
  const labels = [location]
  if (floor && location.startsWith(`${floor} `)) {
    const suffix = location.slice(floor.length).trim()
    if (suffix) labels.push(suffix)
  }
  if (floor && !labels.includes(floor)) labels.push(floor)
  return labels
}

/**
 * Converts an immediately adjacent, whole bare floor/location reply into the
 * effective identity query. Returning null leaves the original request intact.
 * The caller remains responsible for fetching and authorizing `currentCandidates`.
 */
export function resolveGuestPlaceIdentityFollowup(input: {
  rawReply: string
  pending: GuestPlaceIdentityPendingFollowup | null | undefined
  currentCandidates: ReadonlyArray<GuestPlaceIdentityFollowupCandidate>
}): string | null {
  const reply = guestPlaceIdentityKey(input.rawReply)
  if (!reply || !input.pending?.requestedName || isExplicitGuestPlaceNonIdentityRequest(reply)) {
    return null
  }

  const requestedNameKey = guestPlaceIdentityKey(input.pending.requestedName)
  // At least one complete stored anchor must still exist in the current
  // authorized set. This prevents withdrawn, private, or relabelled places from
  // reviving stale context while preserving all current same-name duplicates.
  const hasUnchangedAnchor = input.pending.candidates
    .filter((stored) => guestPlaceIdentityKey(stored.name) === requestedNameKey)
    .some((stored) =>
      input.currentCandidates.some(
        (current) =>
          guestPlaceIdentityKey(current.name) === requestedNameKey && sameIdentity(stored, current),
      ),
    )
  if (!hasUnchangedAnchor) return null

  const replyMatchesCurrentLabel = input.currentCandidates
    .filter((candidate) => guestPlaceIdentityKey(candidate.name) === requestedNameKey)
    .some((candidate) => locationLabels(candidate).some((label) => label === reply))
  if (!replyMatchesCurrentLabel) return null

  return `${input.pending.requestedName.trim()} ${input.rawReply.trim()}`
}
