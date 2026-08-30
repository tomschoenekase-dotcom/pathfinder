import { createHash, randomUUID } from 'node:crypto'

import {
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type DatabaseModule = typeof import('@pathfinder/db')
type JobsModule = typeof import('@pathfinder/jobs')
type RuntimeModule = typeof import('./intake-upload-verification-runtime.js')
type ProcessorModule = typeof import('./processors/intake-upload-verification.js')
type IntakeUploadVerificationResources = Awaited<
  ReturnType<RuntimeModule['createIntakeUploadVerificationResources']>
>

const CONFIRMATION = 'pathfinder_disposable_intake_upload_verification'
const enabled =
  process.env.RUN_INTAKE_UPLOAD_WORKER_DB_INTEGRATION === '1' &&
  process.env.PATHFINDER_DISPOSABLE_INTAKE_CONFIRMATION === CONFIRMATION

const eicar = String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`

function pdfFixture(body: string): Buffer {
  return Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream\nendobj\nxref\n0 1\n0000000000 65535 f\ntrailer\n<<>>\nstartxref\n0\n%%EOF`,
    'utf8',
  )
}

function assertLoopbackUrl(name: string, raw: string | undefined, protocol: string): URL {
  if (!raw) throw new Error(`${name} is required`)
  const parsed = new URL(raw)
  if (
    parsed.protocol !== protocol ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error(`${name} must use its exact credential-free IPv4 loopback boundary`)
  }
  return parsed
}

function assertDisposableBoundary(): void {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
  const directDatabaseUrl = new URL(process.env.DIRECT_DATABASE_URL ?? '')
  if (
    databaseUrl.toString() !== directDatabaseUrl.toString() ||
    databaseUrl.hostname !== '127.0.0.1' ||
    !/^\/pathfinder_disposable_intake_worker_[a-z0-9_]+$/u.test(databaseUrl.pathname) ||
    !databaseUrl.port
  ) {
    throw new Error('Shakedown requires one identical exact-name disposable loopback database')
  }
  assertLoopbackUrl('REDIS_URL', process.env.REDIS_URL, 'redis:')
  const storage = assertLoopbackUrl('STORAGE_ENDPOINT', process.env.STORAGE_ENDPOINT, 'http:')
  if (storage.pathname !== '/') throw new Error('Disposable storage endpoint must not add a path')
  if (process.env.INTAKE_CLAMAV_HOST !== '127.0.0.1' || !process.env.INTAKE_CLAMAV_PORT) {
    throw new Error('Disposable ClamAV must use exact IPv4 loopback')
  }
  if (!/^pathfinder-disposable-intake-[a-z0-9-]+$/u.test(process.env.STORAGE_BUCKET ?? '')) {
    throw new Error('Disposable storage bucket identity is invalid')
  }
  if (
    process.env.RAILWAY_ENVIRONMENT !== 'preview' ||
    process.env.OUTBOUND_PROVIDER_WORKERS_ENABLED !== 'false' ||
    process.env.CRM_BACKGROUND_WORKERS_ENABLED !== 'false'
  ) {
    throw new Error('Shakedown must remain preview-scoped and outbound-provider dark')
  }
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  description: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

type PreparedUpload = {
  tenantId: string
  venueId: string
  uploadId: string
  updatedAt: Date
}

describe.runIf(enabled)('authoritative upload worker disposable shakedown', () => {
  let database: DatabaseModule
  let jobs: JobsModule
  let runtime: RuntimeModule
  let processor: ProcessorModule
  let storage: S3Client
  let resources: IntakeUploadVerificationResources | undefined
  let originalStorageEndpoint: string
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const tenantId = `tenant-intake-${suffix}`
  const venueId = `venue-intake-${suffix}`
  const userId = `user-intake-${suffix}`
  const actor = { type: 'HUMAN' as const, id: userId, role: 'STAFF' as const }

  beforeAll(async () => {
    assertDisposableBoundary()
    ;[database, jobs, runtime, processor] = await Promise.all([
      import('@pathfinder/db'),
      import('@pathfinder/jobs'),
      import('./intake-upload-verification-runtime.js'),
      import('./processors/intake-upload-verification.js'),
    ])
    originalStorageEndpoint = process.env.STORAGE_ENDPOINT!
    storage = new S3Client({
      endpoint: originalStorageEndpoint,
      forcePathStyle: true,
      region: process.env.STORAGE_REGION!,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
      },
    })
    await storage.send(new CreateBucketCommand({ Bucket: process.env.STORAGE_BUCKET! }))
    await storage.send(
      new PutBucketVersioningCommand({
        Bucket: process.env.STORAGE_BUCKET!,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    )
    await database.db.tenant.create({
      data: { id: tenantId, name: 'Disposable intake worker tenant', slug: tenantId },
    })
    await database.db.user.create({
      data: { id: userId, email: `${userId}@example.test`, fullName: 'Disposable Worker Tester' },
    })
    await database.db.tenantMembership.create({
      data: { tenantId, userId, role: 'STAFF', joinedAt: new Date() },
    })
    await database.db.venue.create({
      data: { id: venueId, tenantId, name: 'Disposable Worker Venue', slug: venueId },
    })
    resources = await runtime.createIntakeUploadVerificationResources()
  }, 120_000)

  afterAll(async () => {
    process.env.STORAGE_ENDPOINT = originalStorageEndpoint
    await resources?.close()
    await jobs.closeJobQueues()
    await jobs.closeBullMQConnection()
    storage?.destroy()
    await database.db.$disconnect()
  })

  async function prepareUpload(label: string, bytes: Buffer): Promise<PreparedUpload> {
    const objectGeneration = randomUUID()
    const objectKey = `intake-quarantine/${randomUUID()}`
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const put = await storage.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET!,
        Key: objectKey,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: 'application/pdf',
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        Metadata: { 'pf-intake-upload-generation': objectGeneration },
      }),
    )
    if (!put.VersionId || put.VersionId === 'null') {
      throw new Error('Disposable object storage did not return an immutable version identity')
    }
    const reserved = await database.reserveIntakeUploadAction({
      tenantId,
      venueId,
      actor,
      request: {
        requestId: randomUUID(),
        displayName: label,
        fileName: `${label}.pdf`,
        mimeType: 'application/pdf',
        category: 'DOCUMENT',
        byteSize: bytes.byteLength,
        sha256,
      },
      trustedObjectIdentity: { objectKey, objectGeneration },
    })
    const precheckClaim = randomUUID()
    await database.claimIntakeUploadVerificationAction({
      tenantId,
      venueId,
      uploadId: reserved.upload.id,
      actor,
      claimId: precheckClaim,
    })
    await database.recordIntakeUploadPrecheckAction({
      tenantId,
      venueId,
      uploadId: reserved.upload.id,
      actor,
      claimId: precheckClaim,
      verified: {
        objectGeneration,
        storageVersionId: put.VersionId,
        mimeType: 'application/pdf',
        byteSize: bytes.byteLength,
        sha256,
      },
      evidence: {
        engine: 'disposable-pdf-precheck',
        engineVersion: '1',
        verdictHash: createHash('sha256')
          .update(`disposable-precheck:${reserved.upload.id}:${put.VersionId}`)
          .digest('hex'),
        computedByteSize: bytes.byteLength,
        computedSha256: sha256,
      },
    })
    const row = await database.db.intakeUpload.findFirstOrThrow({
      where: { id: reserved.upload.id, tenantId, venueId },
      select: { updatedAt: true },
    })
    return { tenantId, venueId, uploadId: reserved.upload.id, updatedAt: row.updatedAt }
  }

  async function enqueue(upload: PreparedUpload) {
    await jobs.enqueueIntakeUploadVerification({
      tenantId: upload.tenantId,
      venueId: upload.venueId,
      uploadId: upload.uploadId,
      observedUpdatedAt: upload.updatedAt.toISOString(),
    })
  }

  async function uploadRow(uploadId: string) {
    return database.db.intakeUpload.findFirstOrThrow({
      where: { id: uploadId, tenantId, venueId },
      select: {
        status: true,
        rejectionCode: true,
        intakeRunId: true,
        verificationClaimId: true,
        verificationLeaseUntil: true,
      },
    })
  }

  async function waitForTerminal(uploadId: string) {
    try {
      return await waitFor(async () => {
        const row = await uploadRow(uploadId)
        return row.status === 'AWAITING_REVIEW' || row.status === 'REJECTED' ? row : null
      }, `terminal upload ${uploadId}`)
    } catch (error) {
      const row = await uploadRow(uploadId)
      const jobs = await resources!.queue.getJobs(
        ['waiting', 'active', 'delayed', 'completed', 'failed'],
        0,
        200,
        true,
      )
      const jobEvidence = await Promise.all(
        jobs
          .filter((job) => (job.data as { uploadId?: string }).uploadId === uploadId)
          .map(async (job) => ({
            state: await job.getState(),
            attemptsMade: job.attemptsMade,
            failedReason: job.failedReason,
          })),
      )
      throw new Error(
        `Terminal wait failed: ${error instanceof Error ? error.message : 'unknown'}; state=${row.status}; jobs=${JSON.stringify(jobEvidence)}`,
      )
    }
  }

  async function queueJob(uploadId: string, state?: string) {
    return waitFor(
      async () => {
        const jobs = await resources!.queue.getJobs(
          ['waiting', 'active', 'delayed', 'completed', 'failed'],
          0,
          200,
          true,
        )
        for (const job of jobs) {
          if ((job.data as { uploadId?: string }).uploadId !== uploadId) continue
          if (!state || (await job.getState()) === state) return job
        }
        return null
      },
      `${state ?? 'published'} queue job for ${uploadId}`,
    )
  }

  async function assertSystemEvidence(
    uploadId: string,
    expectedStatus: 'AWAITING_REVIEW' | 'REJECTED',
  ) {
    const receipts = await database.db.intakeUploadVerificationReceipt.findMany({
      where: { tenantId, venueId, uploadId },
      orderBy: { kind: 'asc' },
      select: { kind: true, verdict: true, claimId: true, storageVersionId: true },
    })
    expect(receipts).toHaveLength(3)
    expect(receipts.map(({ kind }) => kind).sort()).toEqual([
      'MALWARE',
      'PRECHECK',
      'RESOURCE_SAFETY',
    ])
    expect(receipts.every(({ storageVersionId }) => storageVersionId.length > 0)).toBe(true)
    const malware = receipts.find(({ kind }) => kind === 'MALWARE')!
    const resource = receipts.find(({ kind }) => kind === 'RESOURCE_SAFETY')!
    expect(malware.verdict).toBe(expectedStatus === 'REJECTED' ? 'REJECTED' : 'CLEAN')
    expect(resource.claimId).toBe(malware.claimId)

    const audits = await database.db.auditLog.findMany({
      where: { tenantId, targetType: 'IntakeUpload', targetId: uploadId, actorType: 'SYSTEM' },
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        actorId: true,
        actorRole: true,
        systemJobId: true,
        capability: true,
        idempotencyKey: true,
      },
    })
    expect(audits.length).toBeGreaterThanOrEqual(2)
    expect(audits.map(({ action }) => action)).toContain(
      expectedStatus === 'REJECTED'
        ? 'intake-upload.authoritative-rejected'
        : 'intake-upload.authoritative-verified',
    )
    for (const audit of audits) {
      expect(audit).toMatchObject({
        actorRole: 'SYSTEM',
        capability: 'intake-upload.authoritative-verify',
      })
      expect(audit.actorId).toBe(audit.systemJobId)
      expect(audit.idempotencyKey).toBeTruthy()
      expect(audit.actorId).not.toContain(uploadId)
    }
    return { audits, malwareClaimId: malware.claimId }
  }

  it('proves clean/infected settlement, same-job retry, and expired-lease reconciliation', async () => {
    const clean = await prepareUpload('clean-fixture', pdfFixture('synthetic clean fixture'))
    await enqueue(clean)
    expect(await waitForTerminal(clean.uploadId)).toMatchObject({
      status: 'AWAITING_REVIEW',
      rejectionCode: null,
      intakeRunId: expect.any(String),
    })
    await assertSystemEvidence(clean.uploadId, 'AWAITING_REVIEW')

    const infected = await prepareUpload('infected-fixture', pdfFixture(eicar))
    await enqueue(infected)
    expect(await waitForTerminal(infected.uploadId)).toMatchObject({
      status: 'REJECTED',
      rejectionCode: 'UNSAFE_FILE',
      intakeRunId: null,
    })
    await assertSystemEvidence(infected.uploadId, 'REJECTED')

    const retry = await prepareUpload('retry-fixture', pdfFixture('synthetic retry fixture'))
    process.env.STORAGE_ENDPOINT = 'http://127.0.0.1:1'
    await enqueue(retry)
    const delayedRetry = await queueJob(retry.uploadId, 'delayed')
    expect(delayedRetry.attemptsMade).toBe(1)
    const retryLease = await uploadRow(retry.uploadId)
    expect(retryLease).toMatchObject({
      status: 'VERIFYING',
      verificationClaimId: expect.any(String),
      verificationLeaseUntil: expect.any(Date),
    })
    expect(await processor.reconcileIntakeUploadVerificationJobs()).toEqual({ discovered: 0 })
    process.env.STORAGE_ENDPOINT = originalStorageEndpoint
    await delayedRetry.promote()
    expect(await waitForTerminal(retry.uploadId)).toMatchObject({
      status: 'AWAITING_REVIEW',
    })
    const completedRetry = await queueJob(retry.uploadId, 'completed')
    expect(completedRetry.attemptsMade).toBeGreaterThanOrEqual(2)
    const retryEvidence = await assertSystemEvidence(retry.uploadId, 'AWAITING_REVIEW')
    expect(retryEvidence.malwareClaimId).toBe(retryLease.verificationClaimId)
    expect(retryEvidence.audits.map(({ action }) => action)).toContain(
      'intake-upload.verification-unavailable',
    )

    const recovery = await prepareUpload(
      'recovery-fixture',
      pdfFixture('synthetic lease recovery fixture'),
    )
    process.env.STORAGE_ENDPOINT = 'http://127.0.0.1:1'
    await enqueue(recovery)
    const lostJob = await queueJob(recovery.uploadId, 'delayed')
    const lostLease = await uploadRow(recovery.uploadId)
    expect(lostLease.verificationClaimId).toEqual(expect.any(String))
    await lostJob.remove()
    expect(await processor.reconcileIntakeUploadVerificationJobs()).toEqual({ discovered: 0 })
    await database.db.intakeUpload.updateMany({
      where: { id: recovery.uploadId, tenantId, venueId, status: 'VERIFYING' },
      data: {
        verificationClaimedAt: new Date(Date.now() - 11 * 60_000),
        verificationLeaseUntil: new Date(Date.now() - 60_000),
      },
    })
    process.env.STORAGE_ENDPOINT = originalStorageEndpoint
    expect(await processor.reconcileIntakeUploadVerificationJobs()).toEqual({ discovered: 1 })
    expect(await waitForTerminal(recovery.uploadId)).toMatchObject({
      status: 'AWAITING_REVIEW',
    })
    const recoveryEvidence = await assertSystemEvidence(recovery.uploadId, 'AWAITING_REVIEW')
    expect(recoveryEvidence.malwareClaimId).not.toBe(lostLease.verificationClaimId)
    const takeover = await database.db.auditLog.findFirstOrThrow({
      where: {
        tenantId,
        targetType: 'IntakeUpload',
        targetId: recovery.uploadId,
        action: 'intake-upload.verification-claimed',
        actorType: 'SYSTEM',
      },
      orderBy: { createdAt: 'desc' },
      select: { beforeState: true },
    })
    expect(takeover.beforeState).toMatchObject({
      status: 'VERIFYING',
      expiredClaimRecovered: true,
    })
  }, 180_000)
})
