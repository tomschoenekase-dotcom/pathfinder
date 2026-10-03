import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import {
  approveSourceConnectionPreviewAction,
  createSourceConnectionDraftAction,
  db,
  loadLiveDataConnectorForPoll,
  readSourceConnectionPreview,
  setSourceConnectionStateAction,
  updateSourceConnectionDraftAction,
} from '../packages/db/src/index'
import {
  SourceConnectionConfigSchema,
  SourceConnectionSnapshotSchema,
} from '../packages/contracts/src/source-connections'
import { sourceConnectionConfigHash } from '../packages/contracts/src/source-connections-node'
import { loadGuestSourceConnections } from '../packages/api/src/lib/guest-source-connections'
import { retrieveGuestKnowledge } from '../packages/api/src/lib/guest-knowledge-retrieval'
import { processSourceConnectionPoll } from '../apps/workers/src/processors/source-connection-poll'
import { fetchSourceConnection } from '../apps/workers/src/lib/source-connection-fetch'

const enabled = process.env.RUN_SOURCE_CONNECTION_DB_INTEGRATION === '1'
const sourceUrl = 'https://venue.example.com/program'
const menuUrl = 'https://venue.example.com/menu'
const config = SourceConnectionConfigSchema.parse({
  version: 1,
  sourceUrl,
  allowedUrls: [sourceUrl, menuUrl],
  timezone: 'America/Chicago',
  refreshIntervalSeconds: 300,
  freshnessSeconds: 3600,
  validation: { minRecords: 4, maxRecords: 10, maxChangedFraction: 0.5, maxRequestsPerDay: 24 },
  publicationPolicy: 'auto_verified',
  mappings: [
    {
      type: 'json_feed',
      kind: 'description',
      itemsPointer: '/descriptions',
      idPointer: '/id',
      titlePointer: '/title',
      textPointer: '/text',
      linksPointer: '/links',
      dateFormat: 'iso',
    },
    {
      type: 'json_feed',
      kind: 'showtime',
      itemsPointer: '/shows',
      idPointer: '/id',
      titlePointer: '/title',
      textPointer: '/text',
      startDatePointer: '/date',
      showtimesPointer: '/intervals',
      cancelledPointer: '/cancelled',
      dateFormat: 'iso',
    },
    {
      type: 'json_feed',
      kind: 'closure',
      itemsPointer: '/closures',
      idPointer: '/id',
      titlePointer: '/title',
      textPointer: '/text',
      startDatePointer: '/date',
      endDatePointer: '/end',
      exceptionsPointer: '/exceptions',
      dateFormat: 'iso',
    },
    {
      type: 'json_feed',
      kind: 'event',
      itemsPointer: '/events',
      idPointer: '/id',
      titlePointer: '/title',
      textPointer: '/text',
      startDatePointer: '/date',
      cancelledPointer: '/cancelled',
      dateFormat: 'iso',
    },
  ],
})

function fixture(version = 1) {
  return {
    descriptions: [
      {
        id: 'description-1',
        title: 'Synthetic visitor description',
        text: `Synthetic source description revision ${version}`,
        links: [menuUrl],
      },
    ],
    shows: [
      {
        id: 'show-1',
        title: 'Synthetic late program',
        text: 'A precisely bounded synthetic program',
        date: '2026-10-03',
        cancelled: false,
        intervals: [{ startAt: '2026-10-03T23:30:00-05:00', endAt: '2026-10-04T00:30:00-05:00' }],
      },
    ],
    closures: [
      {
        id: 'closure-1',
        title: 'Synthetic closure',
        text: 'Closure only on specified dates',
        date: '2026-10-03',
        end: '2026-10-05',
        exceptions: ['2026-10-04'],
      },
    ],
    events: [
      {
        id: 'event-1',
        title: 'Synthetic future event',
        text: 'Future event with an explicit cancellation',
        date: '2026-10-10',
        cancelled: true,
      },
    ],
  }
}

describe.skipIf(!enabled)('source connection disposable database whole flow', () => {
  afterAll(async () => {
    await db.$disconnect()
  })

  it('proves scoped preview/approval/refresh/publication/guest reads, 304, drift, override and rollback', async () => {
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
    expect(databaseUrl.hostname).toBe('127.0.0.1')
    expect(databaseUrl.pathname).toMatch(/^\/pathfinder_disposable_einstein_sourceconn(?:final)?$/u)
    expect(process.env.OUTBOUND_PROVIDER_WORKERS_ENABLED).toBe('false')
    expect(process.env.CRM_BACKGROUND_WORKERS_ENABLED).toBe('false')
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `source-flow-${suffix}`
    const otherTenantId = `source-other-${suffix}`
    const venueId = `source-venue-${suffix}`
    const siblingVenueId = `source-sibling-${suffix}`
    const otherVenueId = `source-foreign-${suffix}`
    const actor = { actorId: 'synthetic-source-manager', actorRole: 'MANAGER' as const }
    const venueScope = { tenantId, venueId }
    let clock = new Date('2026-10-03T17:00:00.000Z')
    let version = 1
    let malformed = false
    let networkRequests = 0
    const requestsByDay = new Map<string, number>()
    let conditionalRequests = 0
    await db.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({ id, name: id, slug: id })),
    })
    await db.venue.createMany({
      data: [
        { id: venueId, tenantId, name: 'Synthetic source venue', slug: venueId },
        { id: siblingVenueId, tenantId, name: 'Synthetic sibling venue', slug: siblingVenueId },
        {
          id: otherVenueId,
          tenantId: otherTenantId,
          name: 'Synthetic foreign venue',
          slug: otherVenueId,
        },
      ],
    })
    await db.venueWebsiteOrigin.create({
      data: {
        ...venueScope,
        origin: 'https://venue.example.com',
        addedBy: actor.actorId,
        addedReason: 'Synthetic disposable fixture only',
      },
    })
    const draft = await createSourceConnectionDraftAction({
      ...venueScope,
      ...actor,
      name: 'Synthetic approved feed',
      config,
    })
    const scope = { ...venueScope, connectorId: draft.id }
    const fetch: NonNullable<Parameters<typeof processSourceConnectionPoll>[2]>['fetch'] = async (
      approved,
      validators,
      deps,
    ) =>
      fetchSourceConnection(approved, validators, {
        ...deps,
        resolveHostname: async () => ['93.184.216.34'],
        request: async (request) => {
          networkRequests += 1
          const day = clock.toISOString().slice(0, 10)
          requestsByDay.set(day, (requestsByDay.get(day) ?? 0) + 1)
          const etag = `"synthetic-${version}"`
          if (request.validators.etag === etag) {
            conditionalRequests += 1
            return { status: 304, headers: { etag }, body: Buffer.alloc(0) }
          }
          const payload = malformed ? { unsupported: true } : fixture(version)
          return {
            status: 200,
            headers: { etag, 'content-type': 'application/feed+json' },
            body: Buffer.from(JSON.stringify(payload)),
          }
        },
      })
    async function poll(mode: 'test' | 'scheduled' | 'manual') {
      const connector = await loadLiveDataConnectorForPoll(scope)
      expect(connector).not.toBeNull()
      return processSourceConnectionPoll({ ...scope, mode }, connector!, {
        now: () => clock,
        fetch,
      })
    }
    async function readConnector() {
      const row = await db.liveDataConnector.findFirst({
        where: { id: scope.connectorId, ...venueScope },
      })
      expect(row).not.toBeNull()
      return row!
    }
    async function snapshot() {
      const row = await db.liveDataObservation.findFirst({ where: scope })
      return SourceConnectionSnapshotSchema.parse(row?.values)
    }
    async function guest(now = clock, target = venueScope) {
      return loadGuestSourceConnections(db, {
        ...target,
        now,
        query: 'synthetic program closure future description',
      })
    }
    async function genericGuest(semantic: boolean) {
      return retrieveGuestKnowledge({
        reader: db,
        ...venueScope,
        includeSecondLayer: false,
        query: 'synthetic',
        queryEmbedding: semantic ? [1] : null,
        asOf: clock,
        // Synthetic semantic candidates deliberately include source facts. The production
        // retriever must revalidate every identity against the actual scoped database.
        semanticSearch: async (searchScope) => {
          expect(searchScope).toEqual({ ...venueScope, includeSecondLayer: false })
          const rows = await db.venueKnowledgeEntry.findMany({
            where: venueScope,
            select: {
              id: true,
              title: true,
              category: true,
              content: true,
              sourceType: true,
              sourceName: true,
              sourceUrl: true,
              contentModuleId: true,
              contentRevisionId: true,
              contentPublicationId: true,
            },
          })
          return rows.map((row) => ({ ...row, distance: 0 }))
        },
      })
    }
    function facts(prompt: string): Array<{ id: string; text: string; cancelled: boolean }> {
      const match = /<untrusted_source_connections>(.*)<\/untrusted_source_connections>/u.exec(
        prompt,
      )
      if (!match) return []
      const data = JSON.parse(match[1]!) as {
        sources: Array<{ facts: Array<{ id: string; text: string; cancelled: boolean }> }>
      }
      return data.sources.flatMap((row) => row.facts)
    }
    expect(await poll('test')).toEqual({ outcome: 'preview-valid' })
    expect(await db.liveDataObservation.count({ where: scope })).toBe(0)
    expect(await db.venueKnowledgeEntry.count({ where: venueScope })).toBe(0)
    expect(facts(await guest())).toEqual([])
    const previewRow = await readConnector()
    const preview = readSourceConnectionPreview(previewRow.lastTestPreview)
    expect(preview?.records).toHaveLength(4)
    expect(preview?.cost.fetches).toBe(1)
    expect(await db.venueSourceInput.count({ where: venueScope })).toBe(1)
    await expect(
      approveSourceConnectionPreviewAction({
        ...scope,
        ...actor,
        expectedUpdatedAt: previewRow.updatedAt.toISOString(),
        previewId: preview!.previewId,
        previewHash: '0'.repeat(64),
        now: clock,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      approveSourceConnectionPreviewAction({
        ...scope,
        tenantId: otherTenantId,
        venueId: otherVenueId,
        ...actor,
        expectedUpdatedAt: previewRow.updatedAt.toISOString(),
        previewId: preview!.previewId,
        previewHash: preview!.previewHash,
        now: clock,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await approveSourceConnectionPreviewAction({
      ...scope,
      ...actor,
      expectedUpdatedAt: previewRow.updatedAt.toISOString(),
      previewId: preview!.previewId,
      previewHash: preview!.previewHash,
      now: clock,
    })
    expect(await poll('scheduled')).toEqual({ outcome: 'published' })
    const initial = await snapshot()
    expect(initial.publicationIds).toHaveLength(4)
    expect(initial.configHash).toBe(sourceConnectionConfigHash(config))
    expect(facts(await guest())).toHaveLength(4)
    expect((await genericGuest(false)).entries).toEqual([])
    expect((await genericGuest(true)).entries).toEqual([])
    expect(facts(await guest(new Date(clock.getTime() + 3_601_000)))).toEqual([])
    expect(facts(await guest()).find((record) => record.id === 'event-1')?.cancelled).toBe(true)
    expect(await guest(clock, { tenantId, venueId: siblingVenueId })).toBe('')
    expect(await guest(clock, { tenantId: otherTenantId, venueId: otherVenueId })).toBe('')
    expect(await loadLiveDataConnectorForPoll({ ...scope, venueId: siblingVenueId })).toBeNull()
    expect(await loadLiveDataConnectorForPoll({ ...scope, tenantId: otherTenantId })).toBeNull()
    const beforeGuestReads = networkRequests
    for (let index = 0; index < 10; index += 1) await guest()
    expect(networkRequests).toBe(beforeGuestReads)
    expect(await poll('manual')).toEqual({ outcome: 'not-due' })
    expect(networkRequests).toBe(beforeGuestReads)

    clock = new Date(clock.getTime() + 300_000)
    expect(await poll('scheduled')).toEqual({ outcome: 'unchanged' })
    const checked = await snapshot()
    expect(conditionalRequests).toBe(1)
    expect(checked.records).toEqual(initial.records)
    expect(checked.publicationIds).toEqual(initial.publicationIds)
    expect(checked.validUntil).toBe(initial.validUntil)
    expect(checked.observedAt).toBe(clock.toISOString())
    expect(await db.contentModuleRevision.count({ where: venueScope })).toBe(4)

    version = 2
    clock = new Date(clock.getTime() + 300_000)
    expect(await poll('scheduled')).toEqual({ outcome: 'published' })
    expect(facts(await guest()).find((record) => record.id === 'description-1')?.text).toContain(
      'revision 2',
    )
    expect(await db.contentModuleRevision.count({ where: venueScope })).toBe(5)
    const updated = await snapshot()
    const overridden = updated.publicationIds.find((record) => record.recordId === 'description-1')!
    const former = await db.contentModuleRevision.findFirst({
      where: { ...venueScope, moduleId: overridden.moduleId },
      orderBy: { version: 'desc' },
    })
    const manual = await db.contentModuleRevision.create({
      data: {
        ...venueScope,
        moduleId: overridden.moduleId,
        kind: 'OPERATIONAL_FACT',
        version: former!.version + 1,
        audience: 'PUBLIC',
        createdBy: actor.actorId,
      },
    })
    await db.operationalFactContent.create({
      data: {
        ...venueScope,
        revisionId: manual.id,
        label: 'Synthetic human override',
        value: 'Synthetic manual description wins',
      },
    })
    await db.contentModulePublication.create({
      data: {
        ...venueScope,
        moduleId: overridden.moduleId,
        revisionId: manual.id,
        moduleKind: 'OPERATIONAL_FACT',
        action: 'PUBLISH',
        requestId: randomUUID(),
        actorId: actor.actorId,
      },
    })
    version = 3
    clock = new Date(clock.getTime() + 300_000)
    expect(['published', 'unchanged']).toContain((await poll('scheduled')).outcome)
    expect(facts(await guest()).some((record) => record.id === 'description-1')).toBe(false)
    expect(
      await db.venueKnowledgeEntry.findFirst({
        where: { id: overridden.knowledgeEntryId, ...venueScope },
        select: { content: true, sourceType: true },
      }),
    ).toEqual({ content: 'Synthetic manual description wins', sourceType: 'UNIVERSAL_CONTENT' })
    expect((await genericGuest(false)).entries.map((row) => row.id)).toEqual([
      overridden.knowledgeEntryId,
    ])
    expect((await genericGuest(true)).entries.map((row) => row.id)).toEqual([
      overridden.knowledgeEntryId,
    ])

    clock = new Date('2026-10-04T05:15:00.000Z') // 00:15 venue time, the late interval is still running.
    expect(await poll('scheduled')).toEqual({ outcome: 'unchanged' })
    const midnightFacts = facts(await guest())
    expect(midnightFacts.some((record) => record.id === 'show-1')).toBe(true)
    expect(midnightFacts.some((record) => record.id === 'closure-1')).toBe(false) // Explicit exception day.
    expect(midnightFacts.some((record) => record.id === 'event-1')).toBe(true)
    clock = new Date('2026-10-04T05:31:00.000Z')
    expect(await poll('scheduled')).toEqual({ outcome: 'unchanged' })
    expect(facts(await guest()).some((record) => record.id === 'show-1')).toBe(false)

    malformed = true
    version = 4 // Rejected content must never lend its validator to the previous good snapshot.
    clock = new Date(clock.getTime() + 300_000)
    expect(await poll('scheduled')).toMatchObject({ outcome: 'review-required' })
    expect(facts(await guest())).toEqual([])
    expect(await readConnector()).toMatchObject({ lastErrorCategory: 'review_required' })
    clock = new Date(clock.getTime() + 300_000)
    expect(await poll('scheduled')).toMatchObject({ outcome: 'review-required' })
    expect(facts(await guest())).toEqual([])
    expect(await db.venueSourceInput.count({ where: venueScope })).toBeGreaterThan(5)
    expect(
      await db.venueSourceInput.count({ where: { ...venueScope, disposition: 'FAILED' } }),
    ).toBeGreaterThan(0)
    malformed = false
    version = 3
    clock = new Date(clock.getTime() + 300_000)
    expect(await poll('scheduled')).toEqual({ outcome: 'unchanged' })
    expect(facts(await guest()).some((record) => record.id === 'event-1')).toBe(true)

    const sourceRevision = initial.publicationIds.find((record) => record.recordId === 'event-1')!
    await db.contentModulePublication.create({
      data: {
        ...venueScope,
        moduleId: sourceRevision.moduleId,
        revisionId: sourceRevision.revisionId,
        moduleKind: 'OPERATIONAL_FACT',
        action: 'WITHDRAW',
        requestId: randomUUID(),
        actorId: actor.actorId,
      },
    })
    expect(facts(await guest()).some((record) => record.id === 'event-1')).toBe(false)
    const publishCount = await db.contentModulePublication.count({ where: venueScope })
    clock = new Date(clock.getTime() + 300_000)
    expect(await poll('scheduled')).toEqual({ outcome: 'unchanged' })
    expect(await db.contentModulePublication.count({ where: venueScope })).toBe(publishCount)
    expect(facts(await guest()).some((record) => record.id === 'event-1')).toBe(false)

    const row = await readConnector()
    await setSourceConnectionStateAction({
      ...scope,
      ...actor,
      expectedUpdatedAt: row.updatedAt.toISOString(),
      state: 'DISABLED',
      now: clock,
    })
    expect(facts(await guest())).toEqual([])
    const paused = await readConnector()
    await updateSourceConnectionDraftAction({
      ...scope,
      ...actor,
      expectedUpdatedAt: paused.updatedAt.toISOString(),
      config: { ...config, allowedUrls: [sourceUrl] },
    })
    const edited = await readConnector()
    expect(SourceConnectionConfigSchema.parse(edited.mapping).approval).toBeUndefined()
    await expect(
      setSourceConnectionStateAction({
        ...scope,
        ...actor,
        expectedUpdatedAt: edited.updatedAt.toISOString(),
        state: 'ACTIVE',
        now: clock,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(
      await db.venueKnowledgeEntry.count({ where: { tenantId, venueId: siblingVenueId } }),
    ).toBe(0)
    expect(
      await db.venueKnowledgeEntry.count({
        where: { tenantId: otherTenantId, venueId: otherVenueId },
      }),
    ).toBe(0)
    const metadata = edited.lastTestPreview as {
      usage?: { requests: number; llmTokens: number; llmCostUsd: number }
    }
    expect(metadata.usage).toMatchObject({
      requests: requestsByDay.get(clock.toISOString().slice(0, 10)),
      llmTokens: 0,
      llmCostUsd: 0,
    })
    expect(
      await db.auditLog.count({ where: { tenantId, targetId: scope.connectorId } }),
    ).toBeGreaterThanOrEqual(4)
  }, 60_000)
})
