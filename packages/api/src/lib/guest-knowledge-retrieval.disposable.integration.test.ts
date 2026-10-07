import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { retrieveGuestKnowledge } from './guest-knowledge-retrieval'

const enabled =
  process.env.RUN_GUEST_KNOWLEDGE_DB_INTEGRATION === '1' &&
  /^postgres(?:ql)?:\/\/[^/]+\/pathfinder_disposable_[a-z0-9_]+(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

describe.skipIf(!enabled)('guest knowledge on disposable PostgreSQL', () => {
  afterAll(async () => {
    if (enabled) await db.$disconnect()
  })

  it('retrieves legacy knowledge without a revision while retaining public and source fences', async () => {
    const suffix = randomUUID()
    const tenantId = `guest-null-${suffix}`
    const venueId = `guest-null-venue-${suffix}`
    const publicId = `guest-null-public-${suffix}`
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Disposable guest retrieval', slug: `guest-null-${suffix}` },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Disposable island', slug: `island-${suffix}` },
      })
      await db.venueKnowledgeEntry.createMany({
        data: [
          { id: publicId, visibility: 'PUBLIC', sourceType: 'website_research' },
          {
            id: `guest-null-private-${suffix}`,
            visibility: 'SECOND_LAYER',
            sourceType: 'website_research',
          },
          {
            id: `guest-null-source-${suffix}`,
            visibility: 'PUBLIC',
            sourceType: 'SOURCE_CONNECTION',
          },
        ].map((entry) => ({
          ...entry,
          tenantId,
          venueId,
          title: 'Yuta attractions',
          category: 'rides',
          content: 'The Earth Realm includes the Vulkara launch coaster.',
          isEnabled: true,
        })),
      })
      const result = await retrieveGuestKnowledge({
        reader: db,
        tenantId,
        venueId,
        query: 'Yuta attractions',
        queryEmbedding: null,
        includeSecondLayer: false,
      })
      expect(result.entries.map((entry) => entry.id)).toEqual([publicId])
      expect(result.entries[0]?.content).toContain('Vulkara')
    })
  }, 30_000)
})
