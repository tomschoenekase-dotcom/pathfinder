import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import { afterAll, describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import {
  mergeGuestConversationEntries,
  projectGuestModelHistory,
  type GuestTextHistoryRow,
} from './lib/guest-conversation-history'
import { retrieveGuestKnowledge } from './lib/guest-knowledge-retrieval'

const enabled =
  process.env.RUN_NATIVE_GUEST_READ_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_guest_retrieval_performance_[a-z0-9_]+$/u.test(
    process.env.DATABASE_URL ?? '',
  )

function percentile(samples: number[], percentileRank: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileRank) - 1)]!
}

describe.skipIf(!enabled)('native provider-dark guest retrieval performance baseline', () => {
  afterAll(async () => {
    await db.$disconnect()
  })

  it('records first and repeated reads while preserving correction and bounded history behavior', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `tenant-retrieval-performance-${suffix}`
      const venueId = `venue-retrieval-performance-${suffix}`
      const sourceId = randomUUID()

      await db.tenant.create({
        data: { id: tenantId, name: 'Retrieval performance fixture', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Retrieval performance venue', slug: venueId },
      })
      await db.venueKnowledgeEntry.createMany({
        data: [
          {
            id: sourceId,
            tenantId,
            venueId,
            title: 'North gallery capacity',
            category: 'GENERAL' as const,
            content: 'The north gallery capacity is 137 visitors.',
            visibility: 'PUBLIC' as const,
          },
        ],
      })

      const retrieve = () =>
        retrieveGuestKnowledge({
          reader: db,
          query: 'north gallery capacity',
          tenantId,
          venueId,
          includeSecondLayer: false,
          queryEmbedding: null,
        })
      const measureCase = async () => {
        const initialStartedAt = performance.now()
        const initial = await retrieve()
        const initialReadMs = performance.now() - initialStartedAt
        expect(initial.trace.retrievedSourceIds).toContain(sourceId)
        expect(initial.entries.find(({ id }) => id === sourceId)?.content).toContain('137 visitors')
        const repeatedReadMs: number[] = []
        for (let index = 0; index < 12; index += 1) {
          const startedAt = performance.now()
          const result = await retrieve()
          repeatedReadMs.push(performance.now() - startedAt)
          expect(result.trace.retrievedSourceIds).toContain(sourceId)
        }
        return {
          initialReadMs,
          repeatedReads: {
            sampleCount: repeatedReadMs.length,
            p50Ms: percentile(repeatedReadMs, 0.5),
            p95Ms: percentile(repeatedReadMs, 0.95),
            samplesMs: repeatedReadMs,
          },
        }
      }
      expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(1)
      const smallCorpus = await measureCase()

      await db.venueKnowledgeEntry.createMany({
        data: Array.from({ length: 1_000 }, (_, index) => ({
          tenantId,
          venueId,
          title: `Gallery background ${index}`,
          category: 'GENERAL' as const,
          content: `General exhibit context number ${index}.`,
          visibility: 'PUBLIC' as const,
        })),
      })
      expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(1_001)
      const largeCorpus = await measureCase()

      const corrected = await db.venueKnowledgeEntry.update({
        where: { id: sourceId },
        data: { content: 'The north gallery capacity is now 83 visitors.' },
      })
      const afterCorrection = await retrieve()
      expect(afterCorrection.entries.find(({ id }) => id === sourceId)?.content).toContain(
        '83 visitors',
      )
      expect(JSON.stringify(afterCorrection.entries)).not.toContain('137 visitors')
      expect(afterCorrection.trace.retrievedSources).toContainEqual({
        id: sourceId,
        version: corrected.updatedAt.toISOString(),
      })

      const historyRows: GuestTextHistoryRow[] = Array.from({ length: 1_000 }, (_, index) => ({
        id: `history-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Bounded historical turn ${index}`,
        createdAt: new Date(Date.UTC(2026, 8, 8, 0, 0, index)),
        sessionSequence: index + 1,
      }))
      const historyStartedAt = performance.now()
      const projectedHistory = projectGuestModelHistory(
        mergeGuestConversationEntries({ textRows: historyRows, voiceRows: [], limit: 10 }),
      )
      const boundedHistoryProjectionMs = performance.now() - historyStartedAt
      expect(projectedHistory).toHaveLength(10)
      expect(projectedHistory[0]?.content).toBe('Bounded historical turn 990')

      const measurement = {
        guestRetrievalPerformance: {
          version: 'provider-dark-native-retrieval-performance-v1',
          sourceId,
          sourceVersion: corrected.updatedAt.toISOString(),
          cases: {
            smallCorpus: {
              corpusRows: 1,
              initialReadKind: 'first-retrieval-in-fresh-node-process',
              ...smallCorpus,
            },
            largeCorpus: {
              corpusRows: 1_001,
              initialReadKind: 'first-retrieval-after-corpus-expansion-in-same-process',
              ...largeCorpus,
            },
          },
          boundedHistory: {
            inputRows: historyRows.length,
            outputRows: projectedHistory.length,
            projectionMs: boundedHistoryProjectionMs,
          },
          correctionCurrent: true,
          providerCalled: false,
          interpretation:
            'Only the small-corpus initial read is the first retrieval in a fresh Node process. The large-corpus initial read follows small-corpus reads and fixture expansion. Repeated reads may benefit from PostgreSQL and operating-system buffers. No application response cache is present or claimed.',
        },
      }
      process.stdout.write(`${JSON.stringify(measurement)}\n`)
      const outputPath = process.env.PATHFINDER_DISPOSABLE_PROOF_OUTPUT
      if (outputPath) writeFileSync(outputPath, JSON.stringify(measurement, null, 2))
    })
  })
})
