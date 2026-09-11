import { GuestVisitContextInput } from '@pathfinder/contracts/guest-visit-context'

/** Only already-authorized retrieved places may turn visitor IDs into prompt data. */
export function projectGuestVisitContext(
  input: GuestVisitContextInput | undefined,
  authorizedPlaces: ReadonlyArray<{ id?: string; name: string; areaName?: string | null }>,
) {
  if (!input) return null
  const context = GuestVisitContextInput.parse(input)
  const visitedIds = new Set(context.visitedPlaceIds)
  const visitedPlaces = authorizedPlaces
    .filter((place) => place.id && visitedIds.has(place.id))
    .map((place) => ({ name: place.name, areaName: place.areaName ?? null }))
  if (!context.interests.length && !visitedPlaces.length && context.remainingMinutes == null)
    return null
  return {
    interests: context.interests,
    remainingMinutes: context.remainingMinutes ?? null,
    visitedPlaces,
  }
}
