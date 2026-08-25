import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  EXPECTED_LATEST_MIGRATION,
  readOperationalHealth,
  recordWorkerHeartbeat,
} from './operational-health'

const enabled =
  process.env.RUN_OPERATIONS_READINESS_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_operations_readiness_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('operations readiness migration parity disposable evidence', () => {
  afterAll(async () => db.$disconnect())

  it('recognizes the fresh reviewed lineage without inventing external readiness', async () => {
    const now = new Date('2026-08-25T06:00:00.000Z')
    await recordWorkerHeartbeat({
      mode: 'provider-disabled',
      schedulersEnabled: false,
      revision: 'disposable-operations-readiness',
      now,
    })

    const readiness = await withTenantIsolationBypass(() => readOperationalHealth(now))
    expect(readiness.migration).toEqual({
      expected: EXPECTED_LATEST_MIGRATION,
      applied: EXPECTED_LATEST_MIGRATION,
      appliedAt: expect.any(Date),
      parity: true,
    })
    expect(readiness.worker).toMatchObject({
      state: 'FRESH',
      fresh: true,
      mode: 'provider-disabled',
      schedulersEnabled: false,
      revision: 'disposable-operations-readiness',
    })
    expect(readiness.objectStorage).toEqual({ status: 'not-observed' })
    expect(readiness.malwareScanning).toBeNull()
    expect(readiness.aiProviderOutcomes).toEqual([])
    expect(readiness.emailProviderOutcome).toBeNull()
    expect(readiness.stuckCriticalJobs).toBe(0)
  })
})
