import { AI_EMBEDDING_MODEL_KEYS, generateEmbeddings } from '@pathfinder/ai'
import {
  findVenuePackageKnowledgeSemanticDuplicates,
  findVenuePackagePlaceSemanticDuplicates,
  type VenuePackageSemanticCoverage,
} from '@pathfinder/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: {
    PLACE_CONTENT: 'place-content',
    KNOWLEDGE_CONTENT: 'knowledge-content',
  },
  getAiEmbeddingProfile: (key: string) => `test-profile:${key}`,
  generateEmbeddings: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  buildKnowledgeEntryText: vi.fn((entry) => entry.title),
  buildPlaceText: vi.fn((place) => place.name),
  findVenuePackageKnowledgeSemanticDuplicates: vi.fn(),
  findVenuePackagePlaceSemanticDuplicates: vi.fn(),
}))

import type {
  VenuePackageIssue,
  VenuePackagePayload,
  VenuePackagePayloadV3,
} from '../schemas/venue-package'
import {
  analyzeVenuePackageSemanticDuplicates,
  buildIncompleteSemanticScan,
  generateVenuePackageCandidateEmbeddings,
  sortVenuePackageIssues,
  VENUE_PACKAGE_EMBEDDING_BATCH_SIZE,
  venuePackageSemanticInputs,
} from './venue-package-semantic-analysis'

const emptyCoverage = (): VenuePackageSemanticCoverage => ({
  places: {
    eligibleCount: 0,
    searchableCount: 0,
    missingVectorCount: 0,
    incompatibleVectorCount: 0,
  },
  knowledgeEntries: {
    eligibleCount: 0,
    searchableCount: 0,
    missingVectorCount: 0,
    incompatibleVectorCount: 0,
  },
})

const payload = (placeNames: string[], knowledgeTitles: string[] = []): VenuePackagePayload => ({
  schemaVersion: 1,
  places: placeNames.map((name) => ({
    name,
    type: 'attraction',
    tags: [],
    importanceScore: 0,
  })),
  knowledgeEntries: knowledgeTitles.map((title) => ({
    title,
    category: 'FAQ',
    content: `Content for ${title}`,
    isEnabled: true,
  })),
})

const v3Payload = (): VenuePackagePayloadV3 => ({
  schemaVersion: 3,
  places: {
    create: [
      {
        itemKey: '00000000-0000-4000-8000-000000000001',
        provenance: { sourceType: 'curated-notes', contentOrigin: 'HUMAN_AUTHORED' },
        value: { name: 'New gallery', type: 'gallery', tags: [], importanceScore: 10 },
      },
    ],
    update: [
      {
        itemKey: '00000000-0000-4000-8000-000000000002',
        provenance: { sourceType: 'curated-notes', contentOrigin: 'HUMAN_AUTHORED' },
        id: 'cm00000000000000000000001',
        value: {
          name: 'Updated gallery',
          type: 'gallery',
          itemType: null,
          shortDescription: null,
          longDescription: null,
          lat: null,
          lng: null,
          tags: [],
          importanceScore: 20,
          areaName: null,
          hours: null,
          photoUrl: null,
          isActive: true,
        },
      },
    ],
    delete: [
      {
        itemKey: '00000000-0000-4000-8000-000000000003',
        provenance: { sourceType: 'curated-notes', contentOrigin: 'HUMAN_AUTHORED' },
        id: 'cm00000000000000000000002',
      },
    ],
  },
  knowledgeEntries: {
    create: [
      {
        itemKey: '00000000-0000-4000-8000-000000000004',
        provenance: { sourceType: 'handbook', contentOrigin: 'HUMAN_AUTHORED' },
        value: {
          title: 'New accessibility guidance',
          category: 'ACCESSIBILITY',
          content: 'New guidance',
          isEnabled: true,
        },
      },
    ],
    update: [
      {
        itemKey: '00000000-0000-4000-8000-000000000005',
        provenance: { sourceType: 'handbook', contentOrigin: 'HUMAN_AUTHORED' },
        id: 'cm00000000000000000000003',
        value: {
          title: 'Updated accessibility guidance',
          category: 'ACCESSIBILITY',
          content: 'Updated guidance',
          isEnabled: true,
        },
      },
    ],
    delete: [
      {
        itemKey: '00000000-0000-4000-8000-000000000006',
        provenance: { sourceType: 'handbook', contentOrigin: 'HUMAN_AUTHORED' },
        id: 'cm00000000000000000000004',
      },
    ],
  },
})

describe('venue package semantic analysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findVenuePackagePlaceSemanticDuplicates).mockResolvedValue([])
    vi.mocked(findVenuePackageKnowledgeSemanticDuplicates).mockResolvedValue([])
  })

  it('sorts issues by path, code, and message without mutating the input', () => {
    const issues: VenuePackageIssue[] = [
      { code: 'B', path: 'places.1.name', message: 'first' },
      { code: 'A', path: 'places.0.name', message: 'second' },
      { code: 'A', path: 'places.0.name', message: 'first' },
    ]
    const original = [...issues]

    const sorted = sortVenuePackageIssues(issues)

    expect(sorted).toEqual([
      { code: 'A', path: 'places.0.name', message: 'first' },
      { code: 'A', path: 'places.0.name', message: 'second' },
      { code: 'B', path: 'places.1.name', message: 'first' },
    ])
    expect(issues).toEqual(original)
    expect(sortVenuePackageIssues([...issues].reverse())).toEqual(sorted)
  })

  it('reports incomplete coverage with deterministic scope errors and counts', () => {
    const coverage = emptyCoverage()
    coverage.places = {
      eligibleCount: 5,
      searchableCount: 2,
      missingVectorCount: 2,
      incompatibleVectorCount: 1,
    }
    coverage.knowledgeEntries = {
      eligibleCount: 3,
      searchableCount: 2,
      missingVectorCount: 0,
      incompatibleVectorCount: 1,
    }

    const result = buildIncompleteSemanticScan({
      payload: payload(['Gallery'], ['Accessibility']),
      coverage,
    })

    expect(result.scan).toMatchObject({
      status: 'INCOMPLETE',
      scopes: {
        places: {
          inputCount: 1,
          scannedInputCount: 0,
          existingCount: 5,
          scannedExistingCount: 2,
        },
        knowledgeEntries: {
          inputCount: 1,
          scannedInputCount: 0,
          existingCount: 3,
          scannedExistingCount: 2,
        },
      },
    })
    expect(result.errors.map((issue) => issue.path)).toEqual(['knowledgeEntries', 'places'])
    expect(result.errors[1]!.message).toContain(
      '2 item(s) lack embeddings and 1 item(s) lack a current compatible embedding claim',
    )
  })

  it('includes V3 creates and updates with self-exclusion while excluding deletes', async () => {
    const input = v3Payload()
    const semanticInputs = venuePackageSemanticInputs(input)

    expect(semanticInputs.places).toEqual([
      {
        value: input.places.create[0]!.value,
        path: 'places.create.0.value.name',
      },
      {
        value: input.places.update[0]!.value,
        path: 'places.update.0.value.name',
        excludeId: 'cm00000000000000000000001',
      },
    ])
    expect(semanticInputs.knowledgeEntries).toEqual([
      {
        value: input.knowledgeEntries.create[0]!.value,
        path: 'knowledgeEntries.create.0.value.title',
      },
      {
        value: input.knowledgeEntries.update[0]!.value,
        path: 'knowledgeEntries.update.0.value.title',
        excludeId: 'cm00000000000000000000003',
      },
    ])

    const incomplete = buildIncompleteSemanticScan({ payload: input, coverage: emptyCoverage() })
    expect(incomplete.scan.scopes.places.inputCount).toBe(2)
    expect(incomplete.scan.scopes.knowledgeEntries.inputCount).toBe(2)

    vi.mocked(generateEmbeddings).mockImplementation(async ({ texts }) => ({
      embeddings: texts.map((_, index) => [index + 1]),
      provider: 'openai',
      model: 'test-embedding',
      pricingVersion: 'test-v1',
      usage: {
        inputTokens: texts.length,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      estimatedCostUsd: 0,
      latencyMs: 1,
      attempts: 1,
    }))
    const candidates = await generateVenuePackageCandidateEmbeddings({
      payload: input,
      usageSink: vi.fn().mockResolvedValue(undefined),
      admissionGuard: vi.fn().mockResolvedValue(undefined),
    })
    expect(candidates.places).toEqual([
      { draftIndex: 0, embedding: [1] },
      {
        draftIndex: 1,
        embedding: [2],
        excludeId: 'cm00000000000000000000001',
      },
    ])
    expect(candidates.knowledgeEntries).toEqual([
      { draftIndex: 0, embedding: [1] },
      {
        draftIndex: 1,
        embedding: [2],
        excludeId: 'cm00000000000000000000003',
      },
    ])
  })

  it('finds complete in-package and existing-content matches in stable issue order', async () => {
    vi.mocked(findVenuePackagePlaceSemanticDuplicates).mockResolvedValueOnce([
      {
        entityType: 'PLACE',
        draftIndex: 0,
        existingId: 'place_existing',
        existingLabel: 'Historic Entry',
        cosineDistance: 0.05,
      },
    ])
    vi.mocked(findVenuePackageKnowledgeSemanticDuplicates).mockResolvedValueOnce([
      {
        entityType: 'KNOWLEDGE_ENTRY',
        draftIndex: 0,
        existingId: 'knowledge_existing',
        existingLabel: 'Visitor access guidance',
        cosineDistance: 0.1,
      },
    ])
    const input = payload(['Main Entrance', 'Front Door'], ['Accessibility', 'Accessible Visit'])
    const coverage = emptyCoverage()
    coverage.places = { ...coverage.places, eligibleCount: 1, searchableCount: 1 }
    coverage.knowledgeEntries = {
      ...coverage.knowledgeEntries,
      eligibleCount: 1,
      searchableCount: 1,
    }

    const result = await analyzeVenuePackageSemanticDuplicates({
      db: {} as never,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      payload: input,
      coverage,
      candidates: {
        places: [
          { draftIndex: 0, embedding: [1, 0] },
          { draftIndex: 1, embedding: [0.99, 0.01] },
        ],
        knowledgeEntries: [
          { draftIndex: 0, embedding: [0, 1] },
          { draftIndex: 1, embedding: [0.01, 0.99] },
        ],
      },
    })

    expect(result.scan).toMatchObject({
      status: 'COMPLETE',
      scopes: {
        places: { scannedInputCount: 2, scannedExistingCount: 1 },
        knowledgeEntries: { scannedInputCount: 2, scannedExistingCount: 1 },
      },
    })
    expect(result.warnings.map((issue) => [issue.code, issue.path])).toEqual([
      ['SEMANTIC_DUPLICATE_EXISTING_CONTENT', 'knowledgeEntries.0.title'],
      ['SEMANTIC_DUPLICATE_IN_PACKAGE', 'knowledgeEntries.1.title'],
      ['SEMANTIC_DUPLICATE_EXISTING_CONTENT', 'places.0.name'],
      ['SEMANTIC_DUPLICATE_IN_PACKAGE', 'places.1.name'],
    ])
    expect(result.warnings.some((issue) => issue.message.includes('0.950'))).toBe(true)
    expect(findVenuePackagePlaceSemanticDuplicates).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        maxCosineDistance: 0.14,
      }),
    )
  })

  it('suppresses exact normalized-label semantic matches', async () => {
    vi.mocked(findVenuePackagePlaceSemanticDuplicates).mockResolvedValueOnce([
      {
        entityType: 'PLACE',
        draftIndex: 0,
        existingId: 'place_existing',
        existingLabel: '  COFFEE bar! ',
        cosineDistance: 0,
      },
    ])
    const input = payload(['Coffee-Bar', ' coffee bar '])

    const result = await analyzeVenuePackageSemanticDuplicates({
      db: {} as never,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      payload: input,
      coverage: emptyCoverage(),
      candidates: {
        places: [
          { draftIndex: 0, embedding: [1, 0] },
          { draftIndex: 1, embedding: [1, 0] },
        ],
        knowledgeEntries: [],
      },
    })

    expect(result.warnings).toEqual([])
  })

  it('keeps only the strongest semantic warning for a source path', async () => {
    vi.mocked(findVenuePackagePlaceSemanticDuplicates).mockResolvedValueOnce([
      {
        entityType: 'PLACE',
        draftIndex: 1,
        existingId: 'place_strongest',
        existingLabel: 'North Reception',
        cosineDistance: 0,
      },
    ])
    const input = payload(['Main Entrance', 'Front Door'])

    const result = await analyzeVenuePackageSemanticDuplicates({
      db: {} as never,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      payload: input,
      coverage: emptyCoverage(),
      candidates: {
        places: [
          { draftIndex: 0, embedding: [1, 0] },
          { draftIndex: 1, embedding: [0.99, 0.01] },
        ],
        knowledgeEntries: [],
      },
    })

    expect(result.warnings.filter((issue) => issue.path === 'places.1.name')).toEqual([
      expect.objectContaining({ code: 'SEMANTIC_DUPLICATE_EXISTING_CONTENT' }),
    ])
  })

  it('batches provider inputs and preserves draft order across batch boundaries', async () => {
    vi.mocked(generateEmbeddings).mockImplementation(async ({ modelKey, texts }) => ({
      embeddings: texts.map((text) => [
        modelKey === AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT
          ? Number(text.replace('Place-', ''))
          : 10_000,
      ]),
      provider: 'openai',
      model: 'test-embedding',
      pricingVersion: 'test-v1',
      usage: {
        inputTokens: texts.length,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      estimatedCostUsd: 0,
      latencyMs: 1,
      attempts: 1,
    }))
    const placeCount = VENUE_PACKAGE_EMBEDDING_BATCH_SIZE * 2 + 5
    const input = payload(
      Array.from({ length: placeCount }, (_, index) => `Place-${index}`),
      ['Knowledge-0'],
    )
    const usageSink = vi.fn().mockResolvedValue(undefined)

    const result = await generateVenuePackageCandidateEmbeddings({
      payload: input,
      usageSink,
      admissionGuard: vi.fn().mockResolvedValue(undefined),
    })

    const placeCalls = vi
      .mocked(generateEmbeddings)
      .mock.calls.filter(([call]) => call.modelKey === AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT)
    expect(placeCalls.map(([call]) => call.texts.length)).toEqual([
      VENUE_PACKAGE_EMBEDDING_BATCH_SIZE,
      VENUE_PACKAGE_EMBEDDING_BATCH_SIZE,
      5,
    ])
    expect(placeCalls.every(([call]) => call.usageSink === usageSink)).toBe(true)
    expect(result.places.map((candidate) => candidate.draftIndex)).toEqual(
      Array.from({ length: placeCount }, (_, index) => index),
    )
    expect(result.places.map((candidate) => candidate.embedding[0])).toEqual(
      Array.from({ length: placeCount }, (_, index) => index),
    )
    expect(result.knowledgeEntries).toEqual([{ draftIndex: 0, embedding: [10_000] }])
  })

  it('stops before another provider batch when usage evidence becomes unavailable', async () => {
    let usagePersistenceFailed = false
    vi.mocked(generateEmbeddings).mockImplementation(async ({ texts }) => {
      usagePersistenceFailed = true
      return {
        embeddings: texts.map(() => [1]),
        provider: 'openai',
        model: 'test-embedding',
        pricingVersion: 'test-v1',
        usage: {
          inputTokens: texts.length,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        estimatedCostUsd: 0,
        latencyMs: 1,
        attempts: 1,
      }
    })
    const input = payload(
      Array.from(
        { length: VENUE_PACKAGE_EMBEDDING_BATCH_SIZE + 1 },
        (_, index) => `Place-${index}`,
      ),
    )

    await expect(
      generateVenuePackageCandidateEmbeddings({
        payload: input,
        usageSink: vi.fn().mockResolvedValue(undefined),
        admissionGuard: vi.fn().mockResolvedValue(undefined),
        shouldAbort: () => usagePersistenceFailed,
      }),
    ).rejects.toThrow('Embedding usage evidence is unavailable')

    expect(generateEmbeddings).toHaveBeenCalledTimes(1)
  })

  it('settles both started scopes before rejecting after a delayed usage persistence failure', async () => {
    let usagePersistenceFailed = false
    let terminalObserved = false
    let lateUsageCallbacks = 0
    let resolveKnowledgeStarted!: () => void
    let releaseKnowledgeUsage!: () => void
    let resolvePlaceUsageFailed!: () => void
    const knowledgeStarted = new Promise<void>((resolve) => {
      resolveKnowledgeStarted = resolve
    })
    const knowledgeUsageReleased = new Promise<void>((resolve) => {
      releaseKnowledgeUsage = resolve
    })
    const placeUsageFailed = new Promise<void>((resolve) => {
      resolvePlaceUsageFailed = resolve
    })
    const usageSink = vi.fn(async (event: { scope: 'places' | 'knowledgeEntries' }) => {
      if (terminalObserved) lateUsageCallbacks += 1
      if (event.scope === 'places') {
        usagePersistenceFailed = true
        throw new Error('usage database unavailable')
      }
    })

    vi.mocked(generateEmbeddings).mockImplementation(
      async ({ modelKey, texts, usageSink: providerUsageSink }) => {
        const scope =
          modelKey === AI_EMBEDDING_MODEL_KEYS.PLACE_CONTENT
            ? ('places' as const)
            : ('knowledgeEntries' as const)
        if (scope === 'places') {
          await knowledgeStarted
          await providerUsageSink({ scope } as never).catch(() => undefined)
          resolvePlaceUsageFailed()
        } else {
          resolveKnowledgeStarted()
          await knowledgeUsageReleased
          await providerUsageSink({ scope } as never)
        }
        return {
          embeddings: texts.map(() => [1]),
          provider: 'openai',
          model: 'test-embedding',
          pricingVersion: 'test-v1',
          usage: {
            inputTokens: texts.length,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          estimatedCostUsd: 0,
          latencyMs: 1,
          attempts: 1,
        }
      },
    )

    const operation = generateVenuePackageCandidateEmbeddings({
      payload: payload(
        ['Place-0'],
        Array.from(
          { length: VENUE_PACKAGE_EMBEDDING_BATCH_SIZE + 1 },
          (_, index) => `Knowledge-${index}`,
        ),
      ),
      usageSink: usageSink as never,
      admissionGuard: vi.fn().mockResolvedValue(undefined),
      shouldAbort: () => usagePersistenceFailed,
    })
    const observedResult = operation.then(
      () => null,
      (error: unknown) => {
        terminalObserved = true
        return error
      },
    )

    await placeUsageFailed
    for (let index = 0; index < 10 && !terminalObserved; index += 1) {
      await Promise.resolve()
    }
    releaseKnowledgeUsage()

    const error = await observedResult
    expect(error).toEqual(new Error('Embedding usage evidence is unavailable'))
    expect(lateUsageCallbacks).toBe(0)
    expect(usageSink).toHaveBeenCalledTimes(2)
    expect(generateEmbeddings).toHaveBeenCalledTimes(2)
    expect(
      vi
        .mocked(generateEmbeddings)
        .mock.calls.filter(([call]) => call.modelKey === AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT),
    ).toHaveLength(1)
  })
})
