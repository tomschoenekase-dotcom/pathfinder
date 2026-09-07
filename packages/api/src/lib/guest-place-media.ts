import type { db } from '@pathfinder/db'

const MAX_PLACES = 12
const MAX_ROWS = 100

type MediaRow = {
  id: string
  approvedReviewSequence: number
  createdAt: Date
  asset: {
    altText: string
    caption: string | null
    sourceName: string
    sourceUrl: string | null
    placeLinks: Array<{ placeId: string }>
    reviews: Array<{ sequence: number; action: string; rightsBasis: string | null }>
  }
}

export type GuestPlaceMediaReader = {
  venueMediaDerivative: Pick<typeof db.venueMediaDerivative, 'findMany'>
}

export type ApprovedGuestPlaceMedia = {
  photoUrl: string
  photoAttribution: {
    altText: string
    caption: string | null
    sourceName: string
    sourceUrl: string | null
  }
}

function safeSourceUrl(value: string | null): string | null {
  if (!value || value.length > 2_000) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    if (
      [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some((key) =>
        /token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-/iu.test(key),
      )
    )
      return null
    const normalized = url.toString()
    return normalized.length <= 2_000 ? normalized : null
  } catch {
    return null
  }
}

// Zod's string bounds use UTF-16 units. Keep complete code points within
// those bounds so multilingual credits cannot invalidate a response envelope.
function boundedCredit(value: string, limit: number): string {
  const clipped = value.trim().slice(0, limit)
  return /[\uD800-\uDBFF]$/u.test(clipped) ? clipped.slice(0, -1) : clipped
}

export async function readApprovedGuestPlaceMedia(params: {
  reader: GuestPlaceMediaReader
  tenantId: string
  venueId: string
  venueSlug: string
  placeIds: string[]
  showPhotos: boolean
  showLinks: boolean
}): Promise<Map<string, ApprovedGuestPlaceMedia>> {
  const placeIds = [...new Set(params.placeIds)].slice(0, MAX_PLACES)
  if (!params.showPhotos || placeIds.length === 0) return new Map()
  const rows = (await params.reader.venueMediaDerivative.findMany({
    where: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      variant: 'CARD',
      status: 'READY',
      mimeType: 'image/webp',
      sha256: { not: null },
      asset: { kind: 'IMAGE', placeLinks: { some: { placeId: { in: placeIds } } } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_ROWS,
    select: {
      id: true,
      approvedReviewSequence: true,
      createdAt: true,
      asset: {
        select: {
          altText: true,
          caption: true,
          sourceName: true,
          sourceUrl: true,
          placeLinks: { where: { placeId: { in: placeIds } }, select: { placeId: true } },
          reviews: {
            orderBy: { sequence: 'desc' },
            take: 1,
            select: { sequence: true, action: true, rightsBasis: true },
          },
        },
      },
    },
  })) as MediaRow[]
  const result = new Map<string, ApprovedGuestPlaceMedia>()
  for (const row of rows) {
    const latest = row.asset.reviews[0]
    if (
      !latest ||
      latest.sequence !== row.approvedReviewSequence ||
      latest.action !== 'APPROVE_CONTENT_USE' ||
      latest.rightsBasis === null
    )
      continue
    for (const { placeId } of row.asset.placeLinks) {
      if (result.has(placeId)) continue
      result.set(placeId, {
        photoUrl: `/api/venue-media/${row.id}?venue=${encodeURIComponent(params.venueSlug)}`,
        photoAttribution: {
          altText: boundedCredit(row.asset.altText, 500) || 'Place photo',
          caption: row.asset.caption ? boundedCredit(row.asset.caption, 1_000) || null : null,
          sourceName: boundedCredit(row.asset.sourceName, 500) || 'Venue source',
          sourceUrl: params.showLinks ? safeSourceUrl(row.asset.sourceUrl) : null,
        },
      })
    }
  }
  return result
}
