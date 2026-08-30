import type { PublicVenueMediaItem } from '@pathfinder/contracts'

export const VISITOR_MEDIA_MAX_ITEMS = 3
export const VISITOR_MEDIA_MAX_DECLARED_BYTES = 1_200_000

function isControlledDeliveryPath(path: string): boolean {
  return /^\/api\/venue-media\/[0-9a-f-]+\?venue=[^\s]+$/iu.test(path)
}

/**
 * Keeps the visitor surface inside a deterministic transfer budget. The API already returns
 * importance order, but this boundary also refuses unexpected locators and duplicate assets.
 */
export function selectVenueMediaForPresentation(
  items: PublicVenueMediaItem[],
): PublicVenueMediaItem[] {
  const selected: PublicVenueMediaItem[] = []
  const seenAssets = new Set<string>()
  let declaredBytes = 0

  for (const item of items) {
    if (selected.length >= VISITOR_MEDIA_MAX_ITEMS) break
    if (seenAssets.has(item.assetId) || !isControlledDeliveryPath(item.deliveryPath)) continue
    if (declaredBytes + item.byteSize > VISITOR_MEDIA_MAX_DECLARED_BYTES) continue

    selected.push(item)
    seenAssets.add(item.assetId)
    declaredBytes += item.byteSize
  }

  return selected
}
