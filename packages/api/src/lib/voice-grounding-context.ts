import {
  readApprovedGuestPlaceMediaEvidence,
  type GuestPlaceMediaReader,
} from './guest-place-media'
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
  venueMediaDerivative?: GuestPlaceMediaReader['venueMediaDerivative']
}

export type VoiceMediaPolicy = {
  venueSlug: string
  showPhotos: boolean
  showLinks: boolean
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
  /** Server-resolved venue policy; never supplied by the voice client. */
  mediaPolicy?: VoiceMediaPolicy
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
  const coreCandidates = [
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
  const included: typeof coreCandidates = []
  let used = 0
  for (const candidate of coreCandidates) {
    const separator = included.length ? 2 : 0
    if (used + separator + candidate.text.length > MAX_VOICE_CONTEXT_CHARS) continue
    included.push(candidate)
    used += separator + candidate.text.length
  }

  const includedPlaces = authorized.places.filter((place) =>
    included.some((entry) => entry.id === `place:${place.id}`),
  )
  const mediaCandidates: typeof coreCandidates = []
  if (input.mediaPolicy && input.reader.venueMediaDerivative && includedPlaces.length) {
    try {
      const selected = await readApprovedGuestPlaceMediaEvidence({
        reader: { venueMediaDerivative: input.reader.venueMediaDerivative },
        tenantId: input.tenantId,
        venueId: input.venueId,
        venueSlug: input.mediaPolicy.venueSlug,
        placeIds: includedPlaces.map((place) => place.id),
        showPhotos: input.mediaPolicy.showPhotos,
        showLinks: input.mediaPolicy.showLinks,
      })
      const selectedMediaSourceIds = new Set<string>()
      for (const place of includedPlaces) {
        if (mediaCandidates.length >= 3) break
        const evidence = selected.get(place.id)
        if (!evidence) continue
        const sourceId = `media:${evidence.derivativeId}:review:${evidence.approvedReviewSequence}`
        if (selectedMediaSourceIds.has(sourceId)) continue
        const editorialText = [evidence.editorial.altText, evidence.editorial.caption]
          .filter((value): value is string => Boolean(value))
          .join(' · ')
        if (!editorialText) continue
        selectedMediaSourceIds.add(sourceId)
        mediaCandidates.push({
          id: sourceId,
          text: `[APPROVED MEDIA DESCRIPTION · EDITORIAL CAPTION FOR ${String(place.name)}]\n${editorialText}\nSOURCE CREDIT: ${evidence.media.photoAttribution.sourceName}`,
        })
      }
    } catch {
      // Optional media grounding cannot suppress the independently authorized core context.
    }
  }
  for (const candidate of mediaCandidates) {
    const separator = included.length ? 2 : 0
    if (used + separator + candidate.text.length > MAX_VOICE_CONTEXT_CHARS) continue
    included.push(candidate)
    used += separator + candidate.text.length
  }
  const candidates = [...coreCandidates, ...mediaCandidates]
  const context = included.map((candidate) => candidate.text).join('\n\n')
  return {
    context,
    visitContext: projectGuestVisitContext(input.visitContext, includedPlaces),
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
