import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import { db, recordWorkerHeartbeat } from '@pathfinder/db'

import { createSafeOperationalMcpRegistry } from './composition'

const enabled =
  process.env.RUN_JOB_OPERATIONAL_OBSERVABILITY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('job operational observability MCP disposable integration', () => {
  afterAll(async () => db.$disconnect())

  it('separates exact-venue persisted failures from shared runtime and unavailable live-queue evidence', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `job-observability-${suffix}`
    const venueId = `job-observability-venue-${suffix}`
    const otherVenueId = `job-observability-other-${suffix}`
    const privateMarker = `private-job-material-${suffix}`
    const now = new Date()

    await db.tenant.create({ data: { id: tenantId, name: 'Job proof', slug: tenantId } })
    await db.venue.createMany({
      data: [
        { id: venueId, tenantId, name: 'Job proof venue', slug: venueId },
        { id: otherVenueId, tenantId, name: 'Other proof venue', slug: otherVenueId },
      ],
    })
    await db.jobRecord.createMany({
      data: [
        {
          queue: 'weekly-report',
          jobName: 'weekly-report-process',
          tenantId,
          venueId,
          status: 'FAILED',
          payload: { venueId, privateMarker },
          error: privateMarker,
          attemptNumber: 3,
          maxAttempts: 3,
          failureDisposition: 'ATTEMPTS_EXHAUSTED',
          terminalAt: new Date(now.getTime() - 5 * 60_000),
          startedAt: new Date(now.getTime() - 10 * 60_000),
          completedAt: new Date(now.getTime() - 5 * 60_000),
          createdAt: new Date(now.getTime() - 11 * 60_000),
        },
        {
          queue: 'evaluation-run',
          jobName: 'evaluation-run-process',
          tenantId,
          venueId,
          status: 'RUNNING',
          payload: { venueId },
          startedAt: new Date(now.getTime() - 20 * 60_000),
          createdAt: new Date(now.getTime() - 21 * 60_000),
        },
        {
          queue: 'private-other-venue-queue',
          jobName: 'private-other-venue-job',
          tenantId,
          venueId: otherVenueId,
          status: 'FAILED',
          payload: { venueId: otherVenueId, privateMarker: `${privateMarker}-other` },
          error: `${privateMarker}-other`,
          attemptNumber: 1,
          maxAttempts: 1,
          failureDisposition: 'UNRECOVERABLE',
          terminalAt: now,
          startedAt: now,
          completedAt: now,
          createdAt: now,
        },
      ],
    })
    await recordWorkerHeartbeat({
      mode: 'provider-disabled',
      schedulersEnabled: false,
      revision: `job-proof-${suffix}`,
      now,
    })

    const credential: VerifiedMcpCredentialScope = {
      credentialId: `credential-${suffix}`,
      tenantId,
      clientId: tenantId,
      venueIds: [venueId],
      capabilities: ['resources:read', 'jobs:read'],
    }
    const registry = createSafeOperationalMcpRegistry(db)
    const result = await registry.callTool(
      'pathfinder.read',
      { resource: 'jobs', clientId: tenantId, venueId, limit: 25 },
      { credential },
    )

    expect(result.structuredContent).toMatchObject({
      kind: 'pathfinder.jobs',
      data: {
        schemaVersion: 'pathfinder.jobs.v2',
        scope: { clientId: tenantId, venueId },
        persisted: {
          byStatus: expect.arrayContaining([
            expect.objectContaining({ status: 'FAILED', count: 1 }),
            expect.objectContaining({ status: 'RUNNING', count: 1 }),
          ]),
          failedByDisposition: [
            expect.objectContaining({ disposition: 'ATTEMPTS_EXHAUSTED', count: 1 }),
          ],
          longRunning: { count: 1, observedAfterMs: 900000, classification: 'DIAGNOSTIC_ONLY' },
        },
        workerRuntime: {
          state: 'FRESH',
          fresh: true,
          mode: 'provider-disabled',
          revision: `job-proof-${suffix}`,
          schedulersEnabled: false,
        },
        boundaries: {
          persistedRecordsAreLiveQueue: false,
          liveRedisQueueInspected: false,
          liveQueueDepthKnown: false,
          absenceOfRecordsMeansHealthy: false,
          automaticRetryAuthorized: false,
          cancellationAuthorized: false,
          redriveAuthorized: false,
          incidentControlAuthorized: false,
          providerExecutionProven: false,
          serviceLevelObjectivePolicy: 'UNRESOLVED',
        },
        items: expect.arrayContaining([
          expect.objectContaining({ queue: 'weekly-report', status: 'FAILED' }),
          expect.objectContaining({ queue: 'evaluation-run', status: 'RUNNING' }),
        ]),
      },
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(privateMarker)
    expect(serialized).not.toContain('private-other-venue')
    expect(serialized).not.toContain(otherVenueId)

    await expect(
      registry.callTool(
        'pathfinder.read',
        { resource: 'jobs', clientId: tenantId, venueId: otherVenueId, limit: 25 },
        { credential },
      ),
    ).rejects.toThrow('Venue scope denied')
    await expect(
      registry.callTool(
        'pathfinder.read',
        { resource: 'jobs', clientId: tenantId, venueId, limit: 25 },
        { credential: { ...credential, capabilities: ['resources:read'] } },
      ),
    ).rejects.toThrow('Capability denied')
  })
})
