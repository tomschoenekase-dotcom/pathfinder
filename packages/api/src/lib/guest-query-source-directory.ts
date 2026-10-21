import type { EffectivePublishedUniversalContentSnapshot } from '@pathfinder/db'
import { guestKnowledgeScope, guestKnowledgeSelectShape } from './guest-knowledge-retrieval'
import { guestPlaceScope, guestPlaceSelect, pageGuestRows } from './guest-directory-index-loader'
import type { GuestDirectoryKnowledge, GuestDirectoryPlace } from './guest-venue-directory'

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
  const [rows, placeRows, activations] = await Promise.all([
    pageGuestRows((page) =>
      reader.venueKnowledgeEntry.findMany({
        where: { ...guestKnowledgeScope(params), ...page.where },
        select: { ...bodySelect, contentRevision: { select: { createdBy: true } } },
        ...page.args,
      }),
    ),
    pageGuestRows((page) =>
      reader.place.findMany({
        where: { ...guestPlaceScope(params), ...page.where },
        select: { ...guestPlaceSelect, updatedAt: true },
        ...page.args,
      }),
    ),
    reader.legacyKnowledgeAdoptionActivation
      ? reader.legacyKnowledgeAdoptionActivation.findMany({
          where: { tenantId: params.tenantId, venueId: params.venueId },
          select: { adoption: { select: { legacyKnowledgeEntryId: true } } },
        })
      : Promise.resolve([]),
  ])
  const modules = new Map(params.modules.map((module) => [module.moduleId, module]))
  const activatedIds = activations.map((row) => row.adoption.legacyKnowledgeEntryId).sort()
  const activated = new Set(activatedIds)
  const authority = rows.map((row) => {
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
  })
  const knowledge: GuestDirectoryKnowledge[] = rows
    .filter((_, index) => authority[index]!.admitted)
    .map((row) => ({
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
    }))
  const places = placeRows.map((row) => {
    const place = { ...row }
    delete place.updatedAt
    return place
  })
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
