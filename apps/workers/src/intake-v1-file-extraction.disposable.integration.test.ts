import { createHash, randomUUID } from 'node:crypto'

import { GetObjectCommand } from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  objects: new Map<string, { versionId: string; bytes: Buffer; reads: number }>(),
}))

vi.mock('@pathfinder/api/intake-file-extraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/api/intake-file-extraction')>()
  return {
    ...actual,
    executeIntakeFileExtraction: (
      input: Parameters<typeof actual.executeIntakeFileExtraction>[0],
    ) =>
      actual.executeIntakeFileExtraction({
        ...input,
        storage: {
          send: async (command: GetObjectCommand) => {
            if (!(command instanceof GetObjectCommand)) throw new Error('Expected GetObjectCommand')
            const object = fixture.objects.get(command.input.Key ?? '')
            if (!object || command.input.VersionId !== object.versionId) {
              throw new Error('Exact fixture object version unavailable')
            }
            object.reads += 1
            return {
              Body: (async function* () {
                yield object.bytes
              })(),
            }
          },
        },
      }),
  }
})

type DatabaseModule = typeof import('@pathfinder/db')
type JobsModule = typeof import('@pathfinder/jobs')
type RuntimeModule = typeof import('./intake-v1-file-extraction-runtime')

let claimIntakeUploadVerificationAction: DatabaseModule['claimIntakeUploadVerificationAction']
let db: DatabaseModule['db']
let recordIntakeUploadPrecheckAction: DatabaseModule['recordIntakeUploadPrecheckAction']
let reserveIntakeUploadAction: DatabaseModule['reserveIntakeUploadAction']
let settleIntakeUploadAuthoritativeVerificationAction: DatabaseModule['settleIntakeUploadAuthoritativeVerificationAction']
let submitIntakeV1Action: DatabaseModule['submitIntakeV1Action']
let withTenantIsolationBypass: DatabaseModule['withTenantIsolationBypass']
let closeBullMQConnection: JobsModule['closeBullMQConnection']
let closeJobQueues: JobsModule['closeJobQueues']
let enqueueIntakeV1FileExtraction: JobsModule['enqueueIntakeV1FileExtraction']
let INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB: JobsModule['INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB']
let createIntakeV1FileExtractionResources: RuntimeModule['createIntakeV1FileExtractionResources']

const CONFIRMATION = 'pathfinder_disposable_intake_v1_file_runtime'
const enabled =
  process.env.RUN_INTAKE_V1_FILE_RUNTIME_DB_INTEGRATION === '1' &&
  process.env.PATHFINDER_DISPOSABLE_INTAKE_CONFIRMATION === CONFIRMATION

type Resources = Awaited<ReturnType<typeof createIntakeV1FileExtractionResources>>

function assertDisposableBoundary(): void {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
  const directDatabaseUrl = new URL(process.env.DIRECT_DATABASE_URL ?? '')
  const redisUrl = new URL(process.env.REDIS_URL ?? '')
  if (
    databaseUrl.toString() !== directDatabaseUrl.toString() ||
    databaseUrl.hostname !== '127.0.0.1' ||
    !databaseUrl.port ||
    !/^\/pathfinder_disposable_intake_v1_file_runtime_[a-f0-9]{12}$/u.test(databaseUrl.pathname)
  ) {
    throw new Error('Fixture requires one exact disposable loopback database')
  }
  if (
    redisUrl.protocol !== 'redis:' ||
    redisUrl.hostname !== '127.0.0.1' ||
    !redisUrl.port ||
    redisUrl.username ||
    redisUrl.password ||
    (redisUrl.pathname !== '' && redisUrl.pathname !== '/')
  ) {
    throw new Error('Fixture requires a credential-free loopback Redis')
  }
  if (
    process.env.RAILWAY_ENVIRONMENT !== 'preview' ||
    process.env.OUTBOUND_PROVIDER_WORKERS_ENABLED !== 'false' ||
    process.env.INTAKE_V1_FILE_EXTRACTION_WORKERS_ENABLED !== 'true'
  ) {
    throw new Error('Fixture requires preview, provider-dark, explicitly enabled file workers')
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function waitFor<T>(probe: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const result = await probe()
    if (result !== null) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

describe.runIf(enabled)('V1 file extraction worker disposable integration', () => {
  let resources: Resources | undefined

  beforeAll(async () => {
    assertDisposableBoundary()
    const [database, jobs, runtime] = await Promise.all([
      import('@pathfinder/db'),
      import('@pathfinder/jobs'),
      import('./intake-v1-file-extraction-runtime.js'),
    ])
    ;({
      claimIntakeUploadVerificationAction,
      db,
      recordIntakeUploadPrecheckAction,
      reserveIntakeUploadAction,
      settleIntakeUploadAuthoritativeVerificationAction,
      submitIntakeV1Action,
      withTenantIsolationBypass,
    } = database)
    ;({
      closeBullMQConnection,
      closeJobQueues,
      enqueueIntakeV1FileExtraction,
      INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB,
    } = jobs)
    ;({ createIntakeV1FileExtractionResources } = runtime)
  }, 30_000)

  afterAll(async () => {
    if (resources) await resources.close()
    if (closeJobQueues) await closeJobQueues()
    if (closeBullMQConnection) await closeBullMQConnection()
    if (db) await db.$disconnect()
  }, 30_000)

  it('recovers durable file dispatches through the real queue and runtime', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-file-worker-${suffix}`
      const venueId = `venue-file-worker-${suffix}`
      const ownerUserId = `owner-file-worker-${suffix}`
      const actor = { type: 'HUMAN' as const, id: ownerUserId, role: 'MANAGER' as const }
      await db.tenant.create({
        data: { id: tenantId, name: 'File worker fixture', slug: tenantId },
      })
      await db.user.create({ data: { id: ownerUserId, email: `${ownerUserId}@example.test` } })
      await db.tenantMembership.create({
        data: { tenantId, userId: ownerUserId, role: 'MANAGER', joinedAt: new Date() },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'File worker venue', slug: venueId },
      })

      async function verifiedUpload(
        fileName: string,
        mimeType: 'text/plain' | 'application/pdf',
        bytes: Buffer,
      ) {
        const objectGeneration = randomUUID()
        const storageVersionId = `fixture-version-${randomUUID()}`
        const objectKey = `intake-quarantine/${randomUUID()}`
        const reserved = await reserveIntakeUploadAction({
          tenantId,
          venueId,
          actor,
          request: {
            requestId: randomUUID(),
            displayName: fileName,
            fileName,
            mimeType,
            category: 'DOCUMENT',
            byteSize: bytes.byteLength,
            sha256: sha256(bytes),
          },
          trustedObjectIdentity: { objectKey, objectGeneration },
        })
        const precheckClaim = randomUUID()
        await claimIntakeUploadVerificationAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor,
          claimId: precheckClaim,
        })
        await recordIntakeUploadPrecheckAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor,
          claimId: precheckClaim,
          verified: {
            objectGeneration,
            storageVersionId,
            mimeType,
            byteSize: bytes.byteLength,
            sha256: sha256(bytes),
          },
          evidence: {
            engine: 'fixture-precheck',
            engineVersion: '1',
            verdictHash: sha256(`precheck:${fileName}`),
            computedByteSize: bytes.byteLength,
            computedSha256: sha256(bytes),
          },
        })
        const malwareClaim = randomUUID()
        await claimIntakeUploadVerificationAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor,
          claimId: malwareClaim,
        })
        await settleIntakeUploadAuthoritativeVerificationAction({
          tenantId,
          venueId,
          uploadId: reserved.upload.id,
          actor,
          claimId: malwareClaim,
          malware: {
            verdict: 'CLEAN',
            engine: 'fixture-malware',
            engineVersion: '1',
            verdictHash: sha256(`clean:${fileName}`),
            computedByteSize: bytes.byteLength,
            computedSha256: sha256(bytes),
          },
        })
        fixture.objects.set(objectKey, { versionId: storageVersionId, bytes, reads: 0 })
        return { ...reserved.upload, objectKey }
      }

      const textBytes = Buffer.from('The east entrance is step-free and opens at 8 AM.', 'utf8')
      const pdfBytes = Buffer.from('%PDF-1.4\nmalformed fixture', 'utf8')
      const text = await verifiedUpload('visitor-info.txt', 'text/plain', textBytes)
      const pdf = await verifiedUpload('broken.pdf', 'application/pdf', pdfBytes)
      const submission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [],
          intakeUploadIds: [text.id, pdf.id],
        },
      })
      const revision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { tenantId, venueId, submissionId: submission.submissionId, revision: 1 },
        select: { id: true },
      })
      const dispatches = await db.intakeV1ProcessingDispatch.findMany({
        where: { tenantId, venueId, revisionId: revision.id, kind: 'FILE_EXTRACTION' },
        orderBy: { createdAt: 'asc' },
      })
      expect(dispatches).toHaveLength(2)

      resources = await createIntakeV1FileExtractionResources()
      const schedulers = await resources.queue.getJobSchedulers()
      expect(
        schedulers.some(({ key }) => key.includes(INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB)),
      ).toBe(true)
      await resources.queue.add(INTAKE_V1_FILE_EXTRACTION_RECOVERY_JOB, {})

      await waitFor(async () => {
        const rows = await db.intakeV1ProcessingDispatch.findMany({
          where: { id: { in: dispatches.map(({ id }) => id) } },
          select: { id: true, status: true, fileExtractionReceiptId: true },
        })
        return rows.every(({ status }) => status === 'COMPLETED' || status === 'HELD') ? rows : null
      }, 'both file extraction dispatches')

      const receipts = await db.intakeFileExtractionReceipt.findMany({
        where: { tenantId, venueId },
        orderBy: { createdAt: 'asc' },
      })
      expect(receipts).toHaveLength(2)
      expect(receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            uploadId: text.id,
            outcome: 'SUCCEEDED',
            extractedText: textBytes.toString('utf8'),
          }),
          expect.objectContaining({ uploadId: pdf.id, outcome: 'FAILED' }),
        ]),
      )
      const terminal = await db.intakeV1ProcessingDispatch.findMany({
        where: { id: { in: dispatches.map(({ id }) => id) } },
        select: { id: true, status: true },
      })
      expect(terminal.map(({ status }) => status).sort()).toEqual(['COMPLETED', 'HELD'])
      expect(fixture.objects.get(text.objectKey)?.reads).toBe(1)
      expect(fixture.objects.get(pdf.objectKey)?.reads).toBe(1)

      const consumedDuplicates = new Set<string>()
      const onCompleted = (job: { name: string; data: unknown }, result: unknown) => {
        if (
          job.name === 'intake-v1-file-extraction-process' &&
          result === 'not-claimed' &&
          job.data &&
          typeof job.data === 'object' &&
          'dispatchId' in job.data &&
          typeof job.data.dispatchId === 'string'
        ) {
          consumedDuplicates.add(job.data.dispatchId)
        }
      }
      resources.worker.on('completed', onCompleted)
      try {
        for (const dispatch of dispatches) await enqueueIntakeV1FileExtraction(dispatch.id)
        await waitFor(
          async () => (consumedDuplicates.size === dispatches.length ? true : null),
          'duplicate terminal wakeups to be consumed',
        )
      } finally {
        resources.worker.off('completed', onCompleted)
      }
      expect(consumedDuplicates).toEqual(new Set(dispatches.map(({ id }) => id)))
      expect(await db.intakeFileExtractionReceipt.count({ where: { tenantId, venueId } })).toBe(2)
      expect(fixture.objects.get(text.objectKey)?.reads).toBe(1)
      expect(fixture.objects.get(pdf.objectKey)?.reads).toBe(1)
    })
  }, 90_000)
})
