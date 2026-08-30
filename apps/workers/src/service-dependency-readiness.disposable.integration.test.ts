import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { afterAll, describe, expect, it } from 'vitest'

import {
  EXPECTED_LATEST_MIGRATION,
  db,
  readOperationalHealth,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { recordOperationalReadinessHeartbeat } from './lib/service-dependency-readiness'

const enabled =
  process.env.RUN_OPERATIONS_READINESS_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_operations_readiness_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('service dependency readiness disposable evidence', () => {
  let storage: S3Client | null = null

  afterAll(async () => {
    storage?.destroy()
    await db.$disconnect()
  })

  it('proves the fresh migration, bucket, and malware-scanner boundary provider-dark', async () => {
    const now = new Date('2026-08-25T06:30:00.000Z')
    const bucket = process.env.STORAGE_BUCKET!
    storage = new S3Client({
      region: process.env.STORAGE_REGION!,
      endpoint: process.env.STORAGE_ENDPOINT!,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
      },
    })
    await storage.send(new CreateBucketCommand({ Bucket: bucket }))

    const dependencies = await recordOperationalReadinessHeartbeat({
      mode: 'provider-disabled',
      schedulersEnabled: false,
      revision: 'disposable-service-dependency-readiness',
      now,
      environment: {
        STORAGE_BUCKET: bucket,
        STORAGE_REGION: process.env.STORAGE_REGION,
        STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT,
        STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
        STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
        INTAKE_CLAMAV_HOST: process.env.INTAKE_CLAMAV_HOST,
        INTAKE_CLAMAV_PORT: Number(process.env.INTAKE_CLAMAV_PORT),
        INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: true,
      },
    })
    expect(dependencies).toEqual({
      intakeVerificationRequired: true,
      objectStorage: 'up',
      malwareScanner: 'up',
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
    })
    expect(readiness.serviceDependencies).toMatchObject({
      state: 'FRESH',
      fresh: true,
      intakeVerificationRequired: true,
      objectStorage: 'up',
      malwareScanner: 'up',
    })
    expect(readiness.aiProviderOutcomes).toEqual([])
    expect(readiness.emailProviderOutcome).toBeNull()
    expect(readiness.stuckCriticalJobs).toBe(0)
  })
})
