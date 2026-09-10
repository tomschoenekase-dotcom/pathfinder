import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'

import { afterAll, describe, expect, it } from 'vitest'

import {
  acquireEmbeddingWork,
  addUniversalContentRevisionAction,
  createUniversalContentAction,
  db,
  publishUniversalContentAction,
  searchKnowledgeByEmbedding,
  storeKnowledgeEntryEmbeddingForScope,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { retrieveGuestKnowledge } from './lib/guest-knowledge-retrieval'

const enabled =
  process.env.RUN_NATIVE_GUEST_PREPARATION_COMPARISON_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_guest_preparation_comparison_[a-z0-9_]+$/u.test(
    process.env.DATABASE_URL ?? '',
  )

const DIMENSIONS = 1_536
const vector = (axis: number) =>
  Array.from({ length: DIMENSIONS }, (_, index) => (index === axis ? 1 : 0))
const SHA = (value: string) => createHash('sha256').update(value).digest('hex')

function percentile(samples: number[], rank: number) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * rank) - 1)]!
}

describe.skipIf(!enabled)('native prepared pgvector hybrid versus lexical guest retrieval', () => {
  afterAll(async () => {
    await db.$disconnect()
  })

  it('compares identical structural fixtures without exposing private, superseded, expired, or old canonical content', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `tenant-preparation-comparison-${suffix}`
      const venueId = `venue-preparation-comparison-${suffix}`
      const siblingTenantId = `tenant-preparation-comparison-sibling-${suffix}`
      const siblingVenueId = `venue-preparation-comparison-sibling-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: `fixture-owner-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const asOf = new Date('2026-09-08T12:00:00.000Z')

      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Preparation comparison fixture', slug: tenantId },
          {
            id: siblingTenantId,
            name: 'Sibling preparation comparison fixture',
            slug: siblingTenantId,
          },
        ],
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Preparation comparison venue', slug: venueId },
          {
            id: siblingVenueId,
            tenantId: siblingTenantId,
            name: 'Sibling venue',
            slug: siblingVenueId,
          },
        ],
      })

      const expectedCapacityId = `capacity-${suffix}`
      const expectedAccessId = `access-${suffix}`
      const privateId = `private-${suffix}`
      const siblingId = `sibling-${suffix}`
      const staleId = `stale-${suffix}`
      await db.venueKnowledgeEntry.createMany({
        data: [
          {
            id: expectedCapacityId,
            tenantId,
            venueId,
            title: 'North gallery capacity',
            category: 'GENERAL',
            content: 'The north gallery capacity is 137 visitors.',
            visibility: 'PUBLIC',
          },
          {
            id: expectedAccessId,
            tenantId,
            venueId,
            title: 'Quiet access route',
            category: 'GENERAL',
            content: 'The quiet access route begins at the east entry.',
            visibility: 'PUBLIC',
          },
          {
            id: privateId,
            tenantId,
            venueId,
            title: 'Private capacity note',
            category: 'GENERAL',
            content: 'Private capacity note is not guest material.',
            visibility: 'SECOND_LAYER',
          },
          {
            id: staleId,
            tenantId,
            venueId,
            title: 'North gallery capacity',
            category: 'GENERAL',
            content: 'The north gallery capacity is 137 visitors.',
            visibility: 'PUBLIC',
          },
          {
            id: siblingId,
            tenantId: siblingTenantId,
            venueId: siblingVenueId,
            title: 'Sibling capacity',
            category: 'GENERAL',
            content: 'Sibling venue capacity is 999 visitors.',
            visibility: 'PUBLIC',
          },
          ...Array.from({ length: 80 }, (_, index) => ({
            id: `noise-${suffix}-${index}`,
            tenantId,
            venueId,
            title: `Fixture background ${index}`,
            category: 'GENERAL',
            content: `Unrelated fixture context ${index}.`,
            visibility: 'PUBLIC',
          })),
        ],
      })

      const putVector = async (
        entryId: string,
        embedding: number[],
        scope = { tenantId, venueId },
      ) => {
        const entry = await db.venueKnowledgeEntry.findFirstOrThrow({
          where: { id: entryId, tenantId: scope.tenantId, venueId: scope.venueId },
        })
        const leaseToken = randomUUID()
        const claim = await acquireEmbeddingWork({
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          entityType: 'KNOWLEDGE_ENTRY',
          entityId: entry.id,
          contentUpdatedAt: entry.updatedAt,
          sourceHash: SHA([entry.title, entry.category, entry.content].join('\n')),
          embeddingProfile: 'fixture:structural-vector:1536',
          leaseToken,
        })
        if (claim.state !== 'acquired')
          throw new Error(`Expected embedding claim for ${entryId}; got ${claim.state}`)
        await expect(
          storeKnowledgeEntryEmbeddingForScope({
            entryId: entry.id,
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            contentUpdatedAt: entry.updatedAt,
            source: {
              title: entry.title,
              category: entry.category,
              content: entry.content,
              isEnabled: entry.isEnabled,
            },
            embedding,
            claimId: claim.claimId,
            leaseToken,
          }),
        ).resolves.toEqual({ claimCompleted: true, stored: true })
      }

      const measuredVectorWrites = [
        { entryId: expectedCapacityId, embedding: vector(0) },
        { entryId: expectedAccessId, embedding: vector(1) },
        { entryId: privateId, embedding: vector(0) },
        { entryId: staleId, embedding: vector(0) },
      ]
      const preparationStartedAt = performance.now()
      for (const write of measuredVectorWrites) await putVector(write.entryId, write.embedding)
      const preparationMs = performance.now() - preparationStartedAt

      // Sibling setup and readback prove isolation, but are outside the target-venue preparation
      // duration so the reported write count and measured work describe the same operation set.
      await putVector(siblingId, vector(0), { tenantId: siblingTenantId, venueId: siblingVenueId })
      const siblingVectorReadback = await searchKnowledgeByEmbedding({
        queryEmbedding: vector(0),
        tenantId: siblingTenantId,
        venueId: siblingVenueId,
        includeSecondLayer: false,
        asOf,
        limit: 20,
      })
      expect(siblingVectorReadback.map(({ id }) => id)).toContain(siblingId)

      // A canonical correction changes source text/version after its vector write. The old vector remains
      // intentionally pending recomputation; retrieval must still return current canonical text/version only.
      const corrected = await db.venueKnowledgeEntry.update({
        where: { id: staleId },
        data: { content: 'The north gallery capacity is now 83 visitors.' },
      })
      const pendingDispatches = await db.embeddingDispatch.count({
        where: {
          tenantId,
          venueId,
          entityType: 'KNOWLEDGE_ENTRY',
          entityId: staleId,
          contentUpdatedAt: corrected.updatedAt,
        },
      })
      expect(pendingDispatches).toBe(1)

      const supersededModule = randomUUID()
      const supersededV1 = await createUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: supersededModule,
        actor,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'POLICY',
            title: 'Superseded rule',
            rule: 'Old rule: carry red tickets.',
            appliesTo: [],
          },
        },
      })
      await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: supersededModule,
        revisionId: supersededV1.revisionId,
        expectedLatestVersion: 1,
        requestId: randomUUID(),
        actor,
      })
      const supersededEntry = await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { tenantId, venueId, contentModuleId: supersededModule },
      })
      await putVector(supersededEntry.id, vector(0))
      expect(
        (
          await searchKnowledgeByEmbedding({
            queryEmbedding: vector(0),
            tenantId,
            venueId,
            includeSecondLayer: false,
            asOf,
            limit: 20,
          })
        ).map(({ id }) => id),
      ).toContain(supersededEntry.id)
      const supersededV2 = await addUniversalContentRevisionAction({
        db,
        tenantId,
        venueId,
        moduleId: supersededModule,
        expectedLatestVersion: 1,
        actor,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'POLICY',
            title: 'Current rule',
            rule: 'Current rule: carry blue tickets.',
            appliesTo: [],
          },
        },
      })
      await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: supersededModule,
        revisionId: supersededV2.revisionId,
        expectedLatestVersion: 2,
        requestId: randomUUID(),
        actor,
      })

      const expiredModule = randomUUID()
      const expired = await createUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: expiredModule,
        actor,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'OPERATIONAL_FACT',
            label: 'Expired fixture note',
            value: 'This expired note must not appear.',
            expiresAt: '2026-09-08T11:00:00.000Z',
          },
        },
      })
      await publishUniversalContentAction({
        db,
        tenantId,
        venueId,
        moduleId: expiredModule,
        revisionId: expired.revisionId,
        expectedLatestVersion: 1,
        requestId: randomUUID(),
        actor,
      })
      const expiredEntry = await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { tenantId, venueId, contentModuleId: expiredModule },
      })
      await putVector(expiredEntry.id, vector(0))
      expect(
        (
          await searchKnowledgeByEmbedding({
            queryEmbedding: vector(0),
            tenantId,
            venueId,
            includeSecondLayer: false,
            asOf: new Date('2026-09-08T10:00:00.000Z'),
            limit: 20,
          })
        ).map(({ id }) => id),
      ).toContain(expiredEntry.id)

      const corpusRows = await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })
      const semantic = async (queryEmbedding: number[]) =>
        searchKnowledgeByEmbedding({
          queryEmbedding,
          tenantId,
          venueId,
          includeSecondLayer: false,
          asOf,
          limit: 20,
        })
      const heldOut = [
        {
          name: 'capacity',
          query: 'north gallery capacity',
          embedding: vector(0),
          expectedSourceId: expectedCapacityId,
        },
        {
          name: 'access',
          query: 'quiet access route',
          embedding: vector(1),
          expectedSourceId: expectedAccessId,
        },
      ] as const
      const cases = [] as Array<Record<string, unknown>>
      for (const testCase of heldOut) {
        const invokeLexical = () =>
          retrieveGuestKnowledge({
            reader: db,
            query: testCase.query,
            tenantId,
            venueId,
            includeSecondLayer: false,
            queryEmbedding: null,
            asOf,
          })
        const invokePrepared = () =>
          retrieveGuestKnowledge({
            reader: db,
            query: testCase.query,
            tenantId,
            venueId,
            includeSecondLayer: false,
            queryEmbedding: testCase.embedding,
            semanticSearch: () => semantic(testCase.embedding),
            asOf,
          })
        const initialLexicalStartedAt = performance.now()
        let lexical = await invokeLexical()
        const initialLexicalMs = performance.now() - initialLexicalStartedAt
        const initialPreparedStartedAt = performance.now()
        let prepared = await invokePrepared()
        const initialPreparedMs = performance.now() - initialPreparedStartedAt
        const lexicalSamples: number[] = []
        const preparedSamples: number[] = []
        for (let sample = 0; sample < 12; sample += 1) {
          if (sample % 2 === 0) {
            const lexicalStartedAt = performance.now()
            lexical = await invokeLexical()
            lexicalSamples.push(performance.now() - lexicalStartedAt)
            const preparedStartedAt = performance.now()
            prepared = await invokePrepared()
            preparedSamples.push(performance.now() - preparedStartedAt)
          } else {
            const preparedStartedAt = performance.now()
            prepared = await invokePrepared()
            preparedSamples.push(performance.now() - preparedStartedAt)
            const lexicalStartedAt = performance.now()
            lexical = await invokeLexical()
            lexicalSamples.push(performance.now() - lexicalStartedAt)
          }
        }
        expect(lexical.entries.map(({ id }) => id)).toContain(testCase.expectedSourceId)
        expect(prepared.entries.map(({ id }) => id)).toContain(testCase.expectedSourceId)
        expect(prepared.trace.path).toBe('semantic+lexical')
        cases.push({
          name: testCase.name,
          expectedSourceId: testCase.expectedSourceId,
          lexical: {
            initialMs: initialLexicalMs,
            repeatedSamplesMs: lexicalSamples,
            p95Ms: percentile(lexicalSamples, 0.95),
            trace: lexical.trace,
          },
          prepared: {
            initialMs: initialPreparedMs,
            repeatedSamplesMs: preparedSamples,
            p95Ms: percentile(preparedSamples, 0.95),
            trace: prepared.trace,
          },
        })
      }

      const rawSemantic = await semantic(vector(0))
      const rawIds = rawSemantic.map(({ id }) => id)
      expect(rawIds).not.toContain(privateId)
      expect(rawIds).not.toContain(siblingId)
      expect(rawIds).not.toContain(supersededEntry.id)
      expect(rawIds).not.toContain(expiredEntry.id)
      expect(rawIds).toContain(staleId)

      const staleRead = await retrieveGuestKnowledge({
        reader: db,
        query: 'north gallery capacity',
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: vector(0),
        semanticSearch: () => semantic(vector(0)),
        asOf,
      })
      const staleResult = staleRead.entries.find(({ id }) => id === staleId)
      expect(staleResult?.content).toContain('83 visitors')
      expect(staleResult?.content).not.toContain('137 visitors')
      expect(staleRead.trace.retrievedSources).toContainEqual({
        id: staleId,
        version: corrected.updatedAt.toISOString(),
      })
      expect(
        await db.embeddingDispatch.count({
          where: {
            tenantId,
            venueId,
            entityType: 'KNOWLEDGE_ENTRY',
            entityId: staleId,
            contentUpdatedAt: corrected.updatedAt,
          },
        }),
      ).toBe(1)
      const recomputeStartedAt = performance.now()
      await putVector(staleId, vector(2))
      const recomputePersistenceMs = performance.now() - recomputeStartedAt
      const completedRecompute = await db.embeddingWorkClaim.findFirstOrThrow({
        where: {
          tenantId,
          venueId,
          entityType: 'KNOWLEDGE_ENTRY',
          entityId: staleId,
          contentUpdatedAt: corrected.updatedAt,
        },
        select: { status: true, completedAt: true, contentUpdatedAt: true },
      })
      expect(completedRecompute.status).toBe('COMPLETE')
      expect(completedRecompute.contentUpdatedAt).toEqual(corrected.updatedAt)
      expect(completedRecompute.completedAt).not.toBeNull()
      const recomputedSemantic = await semantic(vector(0))
      const recomputedDistance = recomputedSemantic.find(({ id }) => id === staleId)?.distance
      expect(recomputedDistance).toBeDefined()

      const measurement = {
        version: 'guest-preparation-comparison-native-v2',
        fixture: {
          tenantId,
          venueId,
          corpusRows,
          seededStandaloneRows: 85,
          vectorDimensions: DIMENSIONS,
          fixedVectors:
            'Structural fixture inputs only; not embedding, model, or language-quality evidence.',
          structuralValidationManifest: heldOut.map(({ name, query, expectedSourceId }) => ({
            name,
            query,
            expectedSourceId,
          })),
        },
        preparation: {
          vectorPersistenceMs: preparationMs,
          vectorWrites: measuredVectorWrites.length,
          measurementScope: 'target-venue canonical fenced vector writes only',
          recompute: {
            sourceId: staleId,
            currentVersion: corrected.updatedAt.toISOString(),
            dispatchPending: pendingDispatches === 1,
            persistenceMs: recomputePersistenceMs,
            completedClaim: completedRecompute.status,
            changedSemanticDistance: recomputedDistance,
          },
          assumptions:
            'Excludes embedding generation/provider time; measures canonical fenced vector writes only.',
        },
        comparison: { cases, perQuery: cases },
        exclusion: {
          privateId,
          siblingId,
          supersededId: supersededEntry.id,
          expiredId: expiredEntry.id,
          staleId,
          staleVectorMayRank: rawIds.includes(staleId),
          oldContentLeaked: false,
        },
        limits:
          'Small synthetic corpus and fixed vectors. This is structural validation only, not a trained or held-out model evaluation; it does not establish HNSW plan selection, embedding quality, language quality, provider cost, cache efficacy, or a production performance recommendation.',
      }
      const output = process.env.PATHFINDER_DISPOSABLE_PROOF_OUTPUT
      if (output) writeFileSync(output, JSON.stringify(measurement, null, 2))
      process.stdout.write(`${JSON.stringify({ guestPreparationComparison: measurement })}\n`)
    })
  })
})
