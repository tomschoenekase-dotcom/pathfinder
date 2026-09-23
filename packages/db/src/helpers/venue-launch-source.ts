import { createHash } from 'node:crypto'
import { nativeCoreVisibleStateHash } from '@pathfinder/contracts'
import { resolveNativeGuestReadSnapshotAction } from './native-guest-content-read'
import { db } from '../client'

type ReadClient = Pick<typeof db,
  '$queryRaw' | 'venue' | 'place' | 'venueKnowledgeEntry' | 'tenantFeatureFlag' |
  'nativeVenueDeploymentHead' | 'nativeVenueDeploymentEvaluationEvidence'>
type PublicPlace = {
  id: string; name: string; type: string; itemType: string | null
  shortDescription: string | null; longDescription: string | null; tags: string[]
}
type PublicKnowledge = {
  id: string; title: string; category: string; content: string
}
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function guestQrUrl(rawOrigin: string | null | undefined, slug: string, allowLoopbackHttp: boolean) {
  const raw = rawOrigin?.trim()
  if (!raw || !slug || slug === '.' || slug === '..') return null
  try {
    const origin = new URL(raw)
    if (
      (origin.protocol !== 'https:' && !(allowLoopbackHttp && origin.protocol === 'http:' && LOOPBACK_HOSTS.has(origin.hostname))) ||
      (raw !== origin.origin && raw !== `${origin.origin}/`) ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    ) return null
    const url = new URL(`/${encodeURIComponent(slug)}/chat`, origin.origin)
    url.searchParams.set('source', 'qr')
    return url.toString()
  } catch { return null }
}

export type VenueLaunchSource = {
  tenantId: string
  venueId: string
  venueName: string
  release: { kind: 'NATIVE' | 'LEGACY'; id: string; revisionSha256: string }
  publicUrl: string
}

/** Read the current public guest source, never assuming an applied native head is served. */
export async function resolveVenueLaunchSource(input: {
  client: ReadClient
  tenantId: string
  venueId: string
  configuredOrigin: string | null | undefined
  environment?: Readonly<Record<string, string | undefined>>
  allowLoopbackHttp?: boolean
}): Promise<VenueLaunchSource | null> {
  const venue = await input.client.venue.findFirst({
    where: { id: input.venueId, tenantId: input.tenantId },
    select: { id: true, name: true, slug: true, isActive: true, description: true, updatedAt: true,
      guideNotes: true, aiGuideNotes: true },
  })
  if (!venue?.isActive) return null
  // Match the public slug-only resolver. A tenant-scoped slug is not a globally
  // unique public destination; never print a code that could open another venue.
  const destinations = await input.client.$queryRaw<{ id: string; tenantId: string }[]>`
    SELECT id, tenant_id AS "tenantId" FROM venues WHERE slug = ${venue.slug} LIMIT 2
  `
  if (destinations.length !== 1 || destinations[0]?.id !== input.venueId ||
      destinations[0]?.tenantId !== input.tenantId) return null
  const publicUrl = guestQrUrl(input.configuredOrigin, venue.slug, input.allowLoopbackHttp === true)
  if (!publicUrl || !publicUrl.startsWith('https://')) return null
  const snapshot = await resolveNativeGuestReadSnapshotAction({
      client: input.client, tenantId: input.tenantId, venueId: input.venueId,
      ...(input.environment ? { environment: input.environment } : {}),
    })
  const native = snapshot.path === 'NATIVE' && snapshot.releaseId && snapshot.state
  if (native && snapshot.state!.places.length === 0 && snapshot.state!.knowledgeEntries.length === 0 &&
      snapshot.state!.generalizedModules.length === 0) return null
  const [places, knowledge] = await Promise.all([
    input.client.place.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId, isActive: true, visibility: 'PUBLIC' },
      orderBy: { id: 'asc' },
      take: 1001,
      select: { id: true, name: true, type: true, itemType: true, shortDescription: true,
        longDescription: true, tags: true, updatedAt: true },
    }),
    input.client.venueKnowledgeEntry.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId, isEnabled: true, visibility: 'PUBLIC' },
      orderBy: { id: 'asc' },
      take: 1001,
      select: { id: true, title: true, category: true, content: true, updatedAt: true },
    }),
  ])
  if ((!native && places.length === 0 && knowledge.length === 0) || places.length > 1000 || knowledge.length > 1000) return null
  // Native guest projection still uses the public compatibility lookup/index and
  // can fall back for unmatched IDs. Bind both sources so such edits invalidate review.
  const revisionSha256 = createHash('sha256').update(JSON.stringify({
      nativeStateSha256: native ? nativeCoreVisibleStateHash(snapshot.state!) : null,
      venue: { id: venue.id, name: venue.name, slug: venue.slug, description: venue.description,
        guideNotes: venue.guideNotes, aiGuideNotes: venue.aiGuideNotes, updatedAt: venue.updatedAt },
      places: places as PublicPlace[],
      knowledge: knowledge as PublicKnowledge[],
    })).digest('hex')
  return {
    tenantId: input.tenantId, venueId: input.venueId, venueName: venue.name, publicUrl,
    release: { kind: native ? 'NATIVE' : 'LEGACY',
      id: native ? snapshot.releaseId! : `legacy:${createHash('sha256').update(`${input.tenantId}:${input.venueId}`).digest('hex')}`, revisionSha256 },
  }
}
