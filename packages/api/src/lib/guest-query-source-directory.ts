import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import { guestKnowledgeScope, guestKnowledgeSelectShape } from './guest-knowledge-retrieval'
import { guestPlaceScope, guestPlaceSelect, pageGuestRows } from './guest-directory-index-loader'
import type { GuestDirectoryKnowledge, GuestDirectoryPlace } from './guest-venue-directory'
import { MAX_GUEST_QUERY_SOURCE_BYTES } from './guest-query-source-limits'

type KnowledgeRow = GuestDirectoryKnowledge & {
  updatedAt: Date
  contentRevision?: { createdBy?: string } | null
}
type PlaceRow = GuestDirectoryPlace & { updatedAt?: Date }
type Reader = {
  venueKnowledgeEntry: { findMany(args: Record<string, unknown>): Promise<KnowledgeRow[]> }
  place: { findMany(args: Record<string, unknown>): Promise<PlaceRow[]> }
  legacyKnowledgeAdoptionActivation?: {
    findMany(
      args: Record<string, unknown>,
    ): Promise<Array<{ adoption: { legacyKnowledgeEntryId: string } }>>
  }
}

/** Structured-source only: the caller owns one RepeatableRead snapshot and canonical resolution. */
export async function loadGuestQuerySourceDirectory(params: {
  reader: unknown
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  asOf: Date
  modules: readonly EffectivePublishedUniversalContentSnapshot[]
}) {
  const reader = params.reader as Reader
  const full = guestKnowledgeSelectShape()
  // Keep the exact SQL admission scope, but current-head authority is already resolved once.
  // Retain the shallow creator check as a second defense for connected-source rows.
  const bodySelect = Object.fromEntries(
    Object.entries(full).filter(
      ([key]) => !['contentPublication', 'contentRevision'].includes(key),
    ),
  )
  const modules = new Map(params.modules.map((module) => [module.moduleId, module]))
  const activationLoad = reader.legacyKnowledgeAdoptionActivation
    ? reader.legacyKnowledgeAdoptionActivation.findMany({
        where: { tenantId: params.tenantId, venueId: params.venueId },
        select: { adoption: { select: { legacyKnowledgeEntryId: true } } },
      })
    : Promise.resolve([])
  let admittedBytes = 0
  let exceeded = false
  const assertWithinBound = () => {
    if (exceeded) throw new Error('Guest query source exceeds byte bound')
  }
  // Each exact projected object occurs whole in the final directory JSON. Their serialized
  // UTF8 bytes are therefore a lower bound, excluding enclosing fields, arrays and authority.
  // Do not charge rejected rows: their bodies never enter the final source. This bounds early
  // admitted-body accumulation, not a fetched page, excluded rows or canonical hydration.
  const charge = (body: GuestDirectoryKnowledge | GuestDirectoryPlace) => {
    admittedBytes += Buffer.byteLength(JSON.stringify(body), 'utf8')
    if (admittedBytes > MAX_GUEST_QUERY_SOURCE_BYTES) exceeded = true
    assertWithinBound()
  }
  const knowledgeProjection = (row: KnowledgeRow): GuestDirectoryKnowledge => ({
    id: row.id,
    title: row.title,
    category: row.category,
    content: row.content,
    sourceType: row.sourceType,
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    updatedAt: row.updatedAt,
    ...(row.contentModuleId !== undefined ? { contentModuleId: row.contentModuleId } : {}),
    ...(row.contentRevisionId !== undefined ? { contentRevisionId: row.contentRevisionId } : {}),
    ...(row.contentPublicationId !== undefined
      ? { contentPublicationId: row.contentPublicationId }
      : {}),
  })
  const placeProjection = (row: PlaceRow): GuestDirectoryPlace => {
    const place = { ...row }
    delete place.updatedAt
    return place
  }
  const rowAuthority = (row: KnowledgeRow, activated: ReadonlySet<string>) => {
    const binding = [row.contentModuleId, row.contentRevisionId, row.contentPublicationId]
    const present = binding.filter((value) => value !== null && value !== undefined)
    // Valid DB rows satisfy the migration's all-or-none binding constraint. Do not reinterpret a
    // partially bound row as manual content, or quietly omit its potentially applicable body.
    if ((present.length !== 0 && present.length !== 3) || present.some((value) => !value.trim()))
      throw new Error('Inconsistent Knowledge publication binding')
    const module = row.contentModuleId ? modules.get(row.contentModuleId) : undefined
    const admitted =
      row.sourceType !== 'SOURCE_CONNECTION' &&
      !row.contentRevision?.createdBy?.startsWith('source-connection:') &&
      !activated.has(row.id) &&
      (present.length === 0 ||
        Boolean(
          module &&
          module.revisionId === row.contentRevisionId &&
          module.publicationId === row.contentPublicationId,
        ))
    return {
      id: row.id,
      updatedAt: row.updatedAt,
      sourceType: row.sourceType,
      contentModuleId: row.contentModuleId,
      contentRevisionId: row.contentRevisionId,
      contentPublicationId: row.contentPublicationId,
      createdBy: row.contentRevision?.createdBy,
      admitted,
    }
  }
  const knowledgeAuthority: ReturnType<typeof rowAuthority>[] = []
  const [rows, placeRows, activations] = await Promise.all([
    (async () => {
      const activated = new Set(
        (await activationLoad).map((row) => row.adoption.legacyKnowledgeEntryId),
      )
      return pageGuestRows(async (page) => {
        assertWithinBound()
        const rows = await reader.venueKnowledgeEntry.findMany({
          where: { ...guestKnowledgeScope(params), ...page.where },
          select: { ...bodySelect, contentRevision: { select: { createdBy: true } } },
          ...page.args,
        })
        assertWithinBound()
        for (const row of rows) {
          const authority = rowAuthority(row, activated)
          knowledgeAuthority.push(authority)
          if (authority.admitted) charge(knowledgeProjection(row))
        }
        return rows
      })
    })(),
    pageGuestRows(async (page) => {
      assertWithinBound()
      const rows = await reader.place.findMany({
        where: { ...guestPlaceScope(params), ...page.where },
        select: { ...guestPlaceSelect, updatedAt: true },
        ...page.args,
      })
      assertWithinBound()
      for (const row of rows) charge(placeProjection(row))
      return rows
    }),
    activationLoad,
  ])
  const activatedIds = activations.map((row) => row.adoption.legacyKnowledgeEntryId).sort()
  const authority = knowledgeAuthority
  const knowledge: GuestDirectoryKnowledge[] = rows
    .filter((_, index) => authority[index]!.admitted)
    .map(knowledgeProjection)
  const places = placeRows.map(placeProjection)
  return {
    directory: {
      knowledge: knowledge.sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id),
      ),
      places: places.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      incomplete: false,
    },
    // Semantic source identity, not an audit-log/event identity. Private/withdrawn events that
    // leave all admitted facts and authority outcomes unchanged need not alter this version.
    authority: {
      knowledge: authority,
      places: placeRows.map((row) => ({ id: row.id, updatedAt: row.updatedAt })),
      activatedLegacyIds: activatedIds,
    },
  }
}
