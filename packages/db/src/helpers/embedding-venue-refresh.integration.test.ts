import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { db } from '../client'
import {
  claimVenueEmbeddingRefresh,
  getVenueEmbeddingRefresh,
  planVenueEmbeddingRefresh,
  requestVenueEmbeddingRefresh,
  startVenueEmbeddingRefreshRecord,
  stopVenueEmbeddingRefresh,
} from './embedding-venue-refresh'

// Opt-in only on the disposable migrated integration database. No network in unit runs.
const integrationDescribe =
  process.env.RUN_EMBEDDING_DB_INTEGRATION === '1' ? describe : describe.skip
integrationDescribe('venue refresh PostgreSQL concurrency and isolation', () => {
  const suffix = randomUUID()
  const scope = { tenantId: `refresh-tenant-${suffix}`, venueId: `refresh-gallery-${suffix}` }
  const other = { tenantId: `refresh-other-${suffix}`, venueId: `refresh-other-gallery-${suffix}` }
  const second = new PrismaClient()
  const separate = second as unknown as typeof db
  beforeAll(async () => {
    vi.stubEnv('EMBEDDING_DISPATCH_ENABLED', 'false')
    await db.tenant.createMany({
      data: [scope, other].map((s) => ({
        id: s.tenantId,
        name: 'Fictional refresh tenant',
        slug: s.tenantId,
      })),
    })
    await db.venue.createMany({
      data: [scope, other].map((s) => ({
        id: s.venueId,
        tenantId: s.tenantId,
        name: 'Fictional refresh gallery',
        slug: s.venueId,
        isActive: true,
      })),
    })
    await db.place.create({
      data: {
        id: `refresh-exhibit-${suffix}`,
        ...scope,
        name: 'Fictional exhibit',
        type: 'exhibit',
        tags: [],
      },
    })
  })
  afterAll(async () => {
    for (const s of [scope, other]) {
      await db.embeddingVenueRefreshRecord.deleteMany({ where: s })
      await db.embeddingVenueRefresh.deleteMany({ where: s })
      await db.place.deleteMany({ where: s })
      await db.venue.deleteMany({ where: { id: s.venueId, tenantId: s.tenantId } })
      await db.tenant.deleteMany({ where: { id: s.tenantId } })
    }
    await second.$disconnect()
    vi.unstubAllEnvs()
  })
  it('one cross-connection active request wins, one CAS owns execution, unknown retains lock', async () => {
    const plan = await planVenueEmbeddingRefresh(scope)
    const input = {
      ...scope,
      operationKey: `operation-${suffix}`,
      planDigest: plan.planDigest,
      max: 1,
      requestedBy: 'fictional-operator',
    }
    const results = await Promise.allSettled([
      requestVenueEmbeddingRefresh(input),
      requestVenueEmbeddingRefresh(
        { ...input, operationKey: `other-operation-${suffix}` },
        separate,
      ),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const winner = results.find((r) => r.status === 'fulfilled')!
    if (winner.status !== 'fulfilled') throw new Error('No winner')
    const identity = { ...scope, refreshId: winner.value.id }
    expect(await getVenueEmbeddingRefresh({ ...other, refreshId: identity.refreshId })).toBeNull()
    const claims = await Promise.all([
      claimVenueEmbeddingRefresh(identity),
      claimVenueEmbeddingRefresh(identity, separate),
    ])
    expect(claims.filter((r) => r.acquired)).toHaveLength(1)
    const recordId = winner.value.records[0]!.id
    expect(
      (
        await startVenueEmbeddingRefreshRecord({
          ...other,
          refreshId: identity.refreshId,
          recordId,
        })
      ).acquired,
    ).toBe(false)
    expect((await startVenueEmbeddingRefreshRecord({ ...identity, recordId })).acquired).toBe(true)
    expect(
      (await stopVenueEmbeddingRefresh({ ...identity, code: 'PROCESS_INTERRUPTED' })).refresh
        ?.status,
    ).toBe('OUTCOME_UNKNOWN')
    await expect(
      requestVenueEmbeddingRefresh(
        { ...input, operationKey: `third-operation-${suffix}` },
        separate,
      ),
    ).rejects.toMatchObject({ code: 'ACTIVE_REFRESH' })
    expect((await claimVenueEmbeddingRefresh(identity)).acquired).toBe(false)
  })
})
