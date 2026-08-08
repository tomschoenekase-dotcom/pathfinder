import {
  AI_EMBEDDING_MODEL_KEYS,
  generateEmbeddings,
  getAiEmbeddingProfile,
  type AiUsageSink,
} from '@pathfinder/ai'
import {
  buildKnowledgeEntryText,
  buildPlaceText,
  findVenuePackageKnowledgeSemanticDuplicates,
  findVenuePackagePlaceSemanticDuplicates,
  type VenuePackageSemanticCoverage,
  type VenuePackageSemanticDuplicateCandidate,
} from '@pathfinder/db'

import type { TRPCContext } from '../context'
import type {
  VenuePackageIssue,
  VenuePackagePayload,
  VenuePackageSemanticDuplicateScan,
} from '../schemas/venue-package'

export const VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD = 0.86
export const VENUE_PACKAGE_EMBEDDING_BATCH_SIZE = 96

type DbClient = TRPCContext['db']

export const VENUE_PACKAGE_SEMANTIC_PROFILES = {
  places: getAiEmbeddingProfile(AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT),
  knowledgeEntries: getAiEmbeddingProfile(AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT),
} as const

export type VenuePackageCandidateEmbeddings = {
  places: VenuePackageSemanticDuplicateCandidate[]
  knowledgeEntries: VenuePackageSemanticDuplicateCandidate[]
}

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

function issueKey(issue: VenuePackageIssue): string {
  return `${issue.path}\u0000${issue.code}\u0000${issue.message}`
}

export function sortVenuePackageIssues(issues: VenuePackageIssue[]): VenuePackageIssue[] {
  return [...issues].sort((left, right) => {
    const a = issueKey(left)
    const b = issueKey(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return -1
  return dot / Math.sqrt(leftNorm * rightNorm)
}

function quantizedSimilarity(value: number): string {
  return Math.max(-1, Math.min(1, value)).toFixed(3)
}

async function embedBatches(params: {
  modelKey:
    | typeof AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT
    | typeof AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT
  texts: string[]
  usageSink: AiUsageSink
  shouldAbort?: () => boolean
}): Promise<number[][]> {
  const embeddings: number[][] = []
  for (let index = 0; index < params.texts.length; index += VENUE_PACKAGE_EMBEDDING_BATCH_SIZE) {
    if (params.shouldAbort?.()) throw new Error('Embedding usage evidence is unavailable')
    const result = await generateEmbeddings({
      modelKey: params.modelKey,
      texts: params.texts.slice(index, index + VENUE_PACKAGE_EMBEDDING_BATCH_SIZE),
      usageSink: params.usageSink,
      maxAttempts: 1,
    })
    if (params.shouldAbort?.()) throw new Error('Embedding usage evidence is unavailable')
    embeddings.push(...result.embeddings)
  }
  return embeddings
}

export async function generateVenuePackageCandidateEmbeddings(params: {
  payload: VenuePackagePayload
  usageSink: AiUsageSink
  shouldAbort?: () => boolean
}): Promise<VenuePackageCandidateEmbeddings> {
  const placeTexts = params.payload.places.map((place) =>
    buildPlaceText({
      name: place.name,
      type: place.type,
      itemType: place.itemType ?? null,
      shortDescription: place.shortDescription ?? null,
      longDescription: place.longDescription ?? null,
      tags: place.tags,
      areaName: place.areaName ?? null,
      hours: place.hours ?? null,
    }),
  )
  const knowledgeTexts = params.payload.knowledgeEntries.map((entry) =>
    buildKnowledgeEntryText(entry),
  )
  const [placeResult, knowledgeResult] = await Promise.allSettled([
    placeTexts.length > 0
      ? embedBatches({
          modelKey: AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT,
          texts: placeTexts,
          usageSink: params.usageSink,
          ...(params.shouldAbort ? { shouldAbort: params.shouldAbort } : {}),
        })
      : [],
    knowledgeTexts.length > 0
      ? embedBatches({
          modelKey: AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT,
          texts: knowledgeTexts,
          usageSink: params.usageSink,
          ...(params.shouldAbort ? { shouldAbort: params.shouldAbort } : {}),
        })
      : [],
  ])
  if (placeResult.status === 'rejected') throw placeResult.reason
  if (knowledgeResult.status === 'rejected') throw knowledgeResult.reason

  const placeEmbeddings = placeResult.value
  const knowledgeEmbeddings = knowledgeResult.value
  return {
    places: placeEmbeddings.map((embedding, draftIndex) => ({ draftIndex, embedding })),
    knowledgeEntries: knowledgeEmbeddings.map((embedding, draftIndex) => ({
      draftIndex,
      embedding,
    })),
  }
}

type SemanticWarningCandidate = {
  issue: VenuePackageIssue
  similarity: number
  targetKey: string
}

function inPackageWarnings(params: {
  entityType: 'places' | 'knowledgeEntries'
  labels: string[]
  candidates: VenuePackageSemanticDuplicateCandidate[]
}): SemanticWarningCandidate[] {
  const warnings: SemanticWarningCandidate[] = []
  for (let current = 1; current < params.candidates.length; current += 1) {
    const candidate = params.candidates[current]!
    let best: { index: number; similarity: number } | null = null
    for (let prior = 0; prior < current; prior += 1) {
      if (normalizeLabel(params.labels[current]!) === normalizeLabel(params.labels[prior]!))
        continue
      const similarity = cosineSimilarity(candidate.embedding, params.candidates[prior]!.embedding)
      if (
        similarity >= VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD &&
        (!best ||
          similarity > best.similarity ||
          (similarity === best.similarity && prior < best.index))
      ) {
        best = { index: prior, similarity }
      }
    }
    if (best) {
      const path =
        params.entityType === 'places'
          ? `places.${candidate.draftIndex}.name`
          : `knowledgeEntries.${candidate.draftIndex}.title`
      const targetPath =
        params.entityType === 'places'
          ? `places.${best.index}.name`
          : `knowledgeEntries.${best.index}.title`
      warnings.push({
        issue: {
          code: 'SEMANTIC_DUPLICATE_IN_PACKAGE',
          path,
          message: `Semantically similar to ${targetPath} (similarity ${quantizedSimilarity(best.similarity)}).`,
        },
        similarity: best.similarity,
        targetKey: targetPath,
      })
    }
  }
  return warnings
}

function strongestSemanticWarnings(candidates: SemanticWarningCandidate[]): VenuePackageIssue[] {
  const strongest = new Map<string, SemanticWarningCandidate>()
  for (const candidate of candidates) {
    const current = strongest.get(candidate.issue.path)
    if (
      !current ||
      candidate.similarity > current.similarity ||
      (candidate.similarity === current.similarity &&
        (candidate.targetKey < current.targetKey ||
          (candidate.targetKey === current.targetKey && candidate.issue.code < current.issue.code)))
    ) {
      strongest.set(candidate.issue.path, candidate)
    }
  }
  return sortVenuePackageIssues([...strongest.values()].map((candidate) => candidate.issue))
}

export function buildIncompleteSemanticScan(params: {
  payload: VenuePackagePayload
  coverage: VenuePackageSemanticCoverage
}): { scan: VenuePackageSemanticDuplicateScan; errors: VenuePackageIssue[] } {
  const errors: VenuePackageIssue[] = []
  const scopes = {
    places: {
      embeddingProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
      inputCount: params.payload.places.length,
      scannedInputCount: 0,
      existingCount: params.coverage.places.eligibleCount,
      scannedExistingCount: params.coverage.places.searchableCount,
    },
    knowledgeEntries: {
      embeddingProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
      inputCount: params.payload.knowledgeEntries.length,
      scannedInputCount: 0,
      existingCount: params.coverage.knowledgeEntries.eligibleCount,
      scannedExistingCount: params.coverage.knowledgeEntries.searchableCount,
    },
  }
  for (const [name, coverage] of Object.entries(params.coverage)) {
    if (coverage.missingVectorCount + coverage.incompatibleVectorCount > 0) {
      errors.push({
        code: 'SEMANTIC_SCAN_INCOMPLETE',
        path: name,
        message: `${coverage.missingVectorCount} item(s) lack embeddings and ${coverage.incompatibleVectorCount} item(s) lack a current compatible embedding claim. Repair embeddings and save a new draft key.`,
      })
    }
  }
  return {
    scan: {
      status: 'INCOMPLETE',
      similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
      scopes,
    },
    errors: sortVenuePackageIssues(errors),
  }
}

export function buildNotRunSemanticScan(params: {
  payload: VenuePackagePayload
  existingPlaceCount: number
  existingKnowledgeCount: number
}): VenuePackageSemanticDuplicateScan {
  return {
    status: 'NOT_RUN',
    similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
    scopes: {
      places: {
        embeddingProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
        inputCount: params.payload.places.length,
        scannedInputCount: 0,
        existingCount: params.existingPlaceCount,
        scannedExistingCount: 0,
      },
      knowledgeEntries: {
        embeddingProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
        inputCount: params.payload.knowledgeEntries.length,
        scannedInputCount: 0,
        existingCount: params.existingKnowledgeCount,
        scannedExistingCount: 0,
      },
    },
  }
}

export async function analyzeVenuePackageSemanticDuplicates(params: {
  db: DbClient
  tenantId: string
  venueId: string
  payload: VenuePackagePayload
  coverage: VenuePackageSemanticCoverage
  candidates: VenuePackageCandidateEmbeddings
}): Promise<{ scan: VenuePackageSemanticDuplicateScan; warnings: VenuePackageIssue[] }> {
  const maxCosineDistance = 1 - VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD
  const [placeMatches, knowledgeMatches] = await Promise.all([
    findVenuePackagePlaceSemanticDuplicates(params.db, {
      tenantId: params.tenantId,
      venueId: params.venueId,
      profile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
      maxCosineDistance,
      candidates: params.candidates.places,
    }),
    findVenuePackageKnowledgeSemanticDuplicates(params.db, {
      tenantId: params.tenantId,
      venueId: params.venueId,
      profile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
      maxCosineDistance,
      candidates: params.candidates.knowledgeEntries,
    }),
  ])

  const warningCandidates: SemanticWarningCandidate[] = [
    ...inPackageWarnings({
      entityType: 'places',
      labels: params.payload.places.map((place) => place.name),
      candidates: params.candidates.places,
    }),
    ...inPackageWarnings({
      entityType: 'knowledgeEntries',
      labels: params.payload.knowledgeEntries.map((entry) => entry.title),
      candidates: params.candidates.knowledgeEntries,
    }),
    ...placeMatches
      .filter(
        (match) =>
          normalizeLabel(match.existingLabel) !==
          normalizeLabel(params.payload.places[match.draftIndex]!.name),
      )
      .map((match) => ({
        issue: {
          code: 'SEMANTIC_DUPLICATE_EXISTING_CONTENT',
          path: `places.${match.draftIndex}.name`,
          message: `Semantically similar to existing place ${match.existingId} “${match.existingLabel}” (similarity ${quantizedSimilarity(1 - match.cosineDistance)}).`,
        },
        similarity: 1 - match.cosineDistance,
        targetKey: `existing-place:${match.existingId}`,
      })),
    ...knowledgeMatches
      .filter(
        (match) =>
          normalizeLabel(match.existingLabel) !==
          normalizeLabel(params.payload.knowledgeEntries[match.draftIndex]!.title),
      )
      .map((match) => ({
        issue: {
          code: 'SEMANTIC_DUPLICATE_EXISTING_CONTENT',
          path: `knowledgeEntries.${match.draftIndex}.title`,
          message: `Semantically similar to existing knowledge ${match.existingId} “${match.existingLabel}” (similarity ${quantizedSimilarity(1 - match.cosineDistance)}).`,
        },
        similarity: 1 - match.cosineDistance,
        targetKey: `existing-knowledge:${match.existingId}`,
      })),
  ]

  return {
    scan: {
      status: 'COMPLETE',
      similarityThreshold: VENUE_PACKAGE_SEMANTIC_SIMILARITY_THRESHOLD,
      scopes: {
        places: {
          embeddingProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.places,
          inputCount: params.payload.places.length,
          scannedInputCount: params.candidates.places.length,
          existingCount: params.coverage.places.eligibleCount,
          scannedExistingCount: params.coverage.places.searchableCount,
        },
        knowledgeEntries: {
          embeddingProfile: VENUE_PACKAGE_SEMANTIC_PROFILES.knowledgeEntries,
          inputCount: params.payload.knowledgeEntries.length,
          scannedInputCount: params.candidates.knowledgeEntries.length,
          existingCount: params.coverage.knowledgeEntries.eligibleCount,
          scannedExistingCount: params.coverage.knowledgeEntries.searchableCount,
        },
      },
    },
    warnings: strongestSemanticWarnings(warningCandidates),
  }
}
