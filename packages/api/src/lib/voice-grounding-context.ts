import { guestVisitRetrievalQuery } from './guest-visit-retrieval-query'
import type { GuestVisitContextInput } from '@pathfinder/contracts/guest-visit-context'
import { projectGuestVisitContext } from './guest-visit-context'
import type { GuestKnowledgeReader } from './guest-knowledge-retrieval'
import { guestQueryConcepts, retrieveGuestKnowledge } from './guest-knowledge-retrieval'
import {
  applyNativeGuestContentRead,
  type SemanticKnowledgeEntry,
  type SemanticPlace,
} from '@pathfinder/db'
import type { Prisma } from '@prisma/client'
import { nativeCoreVisibleStateHash } from '@pathfinder/contracts'

const MAX_VOICE_CONTEXT_CHARS = 12_000

export type VoiceGroundingReader = GuestKnowledgeReader & {
  place?: { findMany(args: Prisma.PlaceFindManyArgs): Promise<SemanticPlace[]> }
  operationalUpdate?: {
    findMany(args: Prisma.OperationalUpdateFindManyArgs): Promise<VoiceOperationalUpdate[]>
  }
}
type VoiceOperationalUpdate = {
  id: string
  title: string
  body: string
  redirectTo?: string | null
  updateType?: string
  severity?: string
}

export async function buildVoiceGroundingContext(input: {
  reader: VoiceGroundingReader
  tenantId: string
  venueId: string
  query: string
  visitContext?: GuestVisitContextInput
  asOf?: Date
  nativeSnapshot?: Parameters<typeof applyNativeGuestContentRead>[0]['snapshot']
}) {
  const assemblyStarted = performance.now()
  const retrievalQuery = guestVisitRetrievalQuery(input.query, input.visitContext)
  const retrieved = await retrieveGuestKnowledge({
    reader: input.reader,
    tenantId: input.tenantId,
    venueId: input.venueId,
    query: retrievalQuery,
    includeSecondLayer: false,
    queryEmbedding: null,
    ...(input.asOf ? { asOf: input.asOf } : {}),
  })
  const terms = [...new Set(guestQueryConcepts(retrievalQuery).flat())]
  const lexicalWhere = (fields: string[]) => ({
    OR: terms.flatMap((term) =>
      fields.map((field) => ({ [field]: { contains: term, mode: 'insensitive' } })),
    ),
  })
  const [places, updates] = await Promise.all([
    input.reader.place && terms.length
      ? input.reader.place.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            visibility: 'PUBLIC',
            isActive: true,
            ...lexicalWhere(['name', 'shortDescription', 'longDescription', 'areaName']),
          },
          orderBy: [{ importanceScore: 'desc' }, { name: 'asc' }],
          take: 8,
          select: {
            id: true,
            name: true,
            type: true,
            shortDescription: true,
            longDescription: true,
            areaName: true,
            hours: true,
          },
        })
      : [],
    input.reader.operationalUpdate
      ? input.reader.operationalUpdate.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'PUBLISHED',
            isActive: true,
            startsAt: { lte: input.asOf ?? new Date() },
            expiresAt: { gt: input.asOf ?? new Date() },
            OR: [{ placeId: null }, { place: { visibility: 'PUBLIC' } }],
          },
          orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
          take: 8,
          select: {
            id: true,
            title: true,
            body: true,
            redirectTo: true,
            updateType: true,
            severity: true,
          },
        })
      : [],
  ])
  const compatibilityKnowledge: SemanticKnowledgeEntry[] = retrieved.entries.map(
    (entry, index) => ({
      id: entry.id,
      title: entry.title,
      category: entry.category,
      content: entry.content,
      sourceType: entry.sourceType,
      sourceName: entry.sourceName,
      sourceUrl: entry.sourceUrl,
      distance: index,
    }),
  )
  const authorized = input.nativeSnapshot
    ? applyNativeGuestContentRead({
        snapshot: input.nativeSnapshot,
        legacyPlaces: places,
        legacyKnowledgeEntries: compatibilityKnowledge,
      })
    : { path: 'NOT_REQUESTED' as const, places, knowledgeEntries: compatibilityKnowledge }
  const candidates = [
    ...updates.map((update) => ({
      id: `update:${String(update.id)}`,
      text: `[CURRENT UPDATE: ${String(update.title)}]\n${[update.body, update.redirectTo].filter(Boolean).join(' · ')}`,
    })),
    ...authorized.knowledgeEntries.map((entry) => ({
      id: entry.id,
      text: `[KNOWLEDGE: ${entry.title}]\n${entry.content}`,
    })),
    ...authorized.places.map((place) => ({
      id: `place:${String(place.id)}`,
      text: `[PLACE: ${String(place.name)}]\n${[place.type, place.areaName, place.shortDescription, place.longDescription, place.hours].filter(Boolean).join(' · ')}`,
    })),
  ]
  const included: typeof candidates = []
  let used = 0
  for (const candidate of candidates) {
    const separator = included.length ? 2 : 0
    if (used + separator + candidate.text.length > MAX_VOICE_CONTEXT_CHARS) continue
    included.push(candidate)
    used += separator + candidate.text.length
  }
  const context = included.map((candidate) => candidate.text).join('\n\n')
  return {
    context,
    visitContext: projectGuestVisitContext(
      input.visitContext,
      authorized.places.filter((place) =>
        included.some((entry) => entry.id === `place:${place.id}`),
      ),
    ),
    sourceIds: included.map((candidate) => candidate.id),
    retrievedSourceIds: candidates.map((candidate) => candidate.id),
    omittedSourceIds: candidates
      .filter((candidate) => !included.includes(candidate))
      .map((candidate) => candidate.id),
    trace: {
      preOverlayKnowledgeRetrieval: retrieved.trace,
      finalIncludedSourceIds: included.map((candidate) => candidate.id),
    },
    nativeProjection: input.nativeSnapshot
      ? {
          path: input.nativeSnapshot.path,
          effectiveContentPath: authorized.path,
          reason: input.nativeSnapshot.reason,
          releaseId: input.nativeSnapshot.releaseId,
          stateHash: input.nativeSnapshot.state
            ? nativeCoreVisibleStateHash(input.nativeSnapshot.state)
            : null,
        }
      : {
          path: 'NOT_REQUESTED' as const,
          effectiveContentPath: 'NOT_REQUESTED' as const,
          reason: null,
          releaseId: null,
          stateHash: null,
        },
    measurements: {
      retrievalMs: retrieved.trace.retrievalMs,
      retrievalAndAssemblyMs: Math.max(0, performance.now() - assemblyStarted),
      providerLatencyMs: null,
    },
    limits: { maxContextChars: MAX_VOICE_CONTEXT_CHARS },
    provider: { called: false as const, qualityVerified: false as const },
  }
}
