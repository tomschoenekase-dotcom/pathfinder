import { randomUUID } from 'node:crypto'
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { type AiBudgetGate, type GeminiVideoClient, type OpenAiMediaClient } from '@pathfinder/ai'
import type { db as DbClient } from '@pathfinder/db'

const processBudgetGate = vi.hoisted(() => ({
  reserve: vi.fn(async () => ({ id: randomUUID(), reservedUnits: 1_000_000n })),
  markDispatched: vi.fn(async () => undefined),
  settleExact: vi.fn(async () => undefined),
  settleAmbiguous: vi.fn(async () => undefined),
  releaseUndispatched: vi.fn(async () => undefined),
}))

vi.mock('../lib/ai-usage', () => ({
  createWorkerAiUsageSink: () => vi.fn(async () => undefined),
  createWorkerAiBudgetGate: () => processBudgetGate,
}))
vi.mock('../lib/media-provider-budget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/media-provider-budget')>()
  return { ...actual, reserveMediaProviderOperation: vi.fn(async () => undefined) }
})

let db: typeof DbClient
let withTenantIsolationBypass: (typeof import('@pathfinder/db'))['withTenantIsolationBypass']
let analyzeVideoWithGemini: (typeof import('./media-ingestion.js'))['analyzeVideoWithGemini']
let setGeminiVideoClientForTesting: (typeof import('@pathfinder/ai'))['setGeminiVideoClientForTesting']
let attemptCeiling: bigint
let prepareOperation: (typeof import('@pathfinder/db'))['prepareMediaProviderOperation']
let claimOperation: (typeof import('@pathfinder/db'))['claimMediaProviderOperation']
let markDispatched: (typeof import('@pathfinder/db'))['markMediaProviderOperationDispatched']
let processMediaIngestionJob: (typeof import('./media-ingestion.js'))['processMediaIngestionJob']
let setOpenAiMediaClientForTesting: (typeof import('@pathfinder/ai'))['setOpenAiMediaClientForTesting']

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(filename: string, contents: Buffer): Buffer {
  const name = Buffer.from(filename)
  const crc = crc32(contents)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(contents.length, 18)
  local.writeUInt32LE(contents.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(contents.length, 20)
  central.writeUInt32LE(contents.length, 24)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + contents.length, 16)
  return Buffer.concat([local, name, contents, central, name, end])
}

function enabled() {
  if (process.env.RUN_MEDIA_PROVIDER_OPERATION_DB_INTEGRATION !== '1') return false
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    return (
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname) &&
      /^pathfinder_disposable_[a-z0-9_]+$/u.test(url.pathname.slice(1))
    )
  } catch {
    return false
  }
}

const integrationDescribe = enabled() ? describe : describe.skip

integrationDescribe('Gemini receipt recovery (disposable PostgreSQL, fake provider)', () => {
  const suffix = randomUUID()
  const tenantId = `gemini-receipt-tenant-${suffix}`
  const venueId = `gemini-receipt-venue-${suffix}`
  const projectId = `gemini-receipt-project-${suffix}`
  const uploadAttemptId = randomUUID()

  beforeAll(async () => {
    const [database, ai, processor] = await Promise.all([
      import('@pathfinder/db'),
      import('@pathfinder/ai'),
      import('./media-ingestion.js'),
    ])
    db = database.db
    withTenantIsolationBypass = database.withTenantIsolationBypass
    analyzeVideoWithGemini = processor.analyzeVideoWithGemini
    setGeminiVideoClientForTesting = ai.setGeminiVideoClientForTesting
    attemptCeiling = ai.GEMINI_VIDEO_ATTEMPT_CEILING_UNITS
    prepareOperation = database.prepareMediaProviderOperation
    claimOperation = database.claimMediaProviderOperation
    markDispatched = database.markMediaProviderOperationDispatched
    processMediaIngestionJob = processor.processMediaIngestionJob
    setOpenAiMediaClientForTesting = ai.setOpenAiMediaClientForTesting
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Gemini receipt', slug: tenantId } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Gemini venue', slug: venueId },
      })
      await db.mediaIngestionProject.create({
        data: {
          id: projectId,
          tenantId,
          venueId,
          name: 'Gemini project',
          createdBy: 'fixture',
          uploadAttemptId,
        },
      })
    })
  })

  it('stores validated output before failed cleanup and retries cleanup without regeneration', async () => {
    const upload = vi.fn(async ({ config }: { config: { name: string } }) => ({
      name: config.name,
      uri: 'provider://fixture',
      mimeType: 'video/mp4',
      state: 'ACTIVE' as const,
    }))
    const generateContent = vi.fn(async () => ({
      text: JSON.stringify({
        summary: 'A signed entrance.',
        visibleText: [],
        objects: [],
        spatialClues: [],
        uncertainties: [],
        observations: [],
      }),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, cachedContentTokenCount: 0 },
    }))
    const remove = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporary'), { status: 503 }))
      .mockResolvedValue({})
    setGeminiVideoClientForTesting({
      files: { upload, get: vi.fn(), delete: remove },
      models: { generateContent },
    } as GeminiVideoClient)
    const reservation = {
      id: `reservation-${suffix}`,
      reservedUnits: attemptCeiling,
    }
    const budgetGate: AiBudgetGate = {
      reserve: vi.fn(async () => reservation),
      markDispatched: vi.fn(async () => undefined),
      settleExact: vi
        .fn()
        .mockRejectedValueOnce(new Error('accounting temporarily unavailable'))
        .mockResolvedValue(undefined),
      settleAmbiguous: vi.fn(async () => undefined),
      releaseUndispatched: vi.fn(async () => undefined),
    }
    const invoke = () =>
      analyzeVideoWithGemini(
        async () => undefined,
        async () => undefined,
        'C:/fixture/video.mp4',
        100,
        'video.mp4',
        'video-1',
        { tenantId, venueId, projectId, uploadAttemptId, inputSha256: 'a'.repeat(64) },
        'fixture context',
        vi.fn(async () => undefined),
        budgetGate,
      )
    await expect(invoke()).rejects.toThrow('deletion could not be confirmed')
    const pending = await withTenantIsolationBypass(() =>
      db.mediaProviderOperation.findFirstOrThrow({ where: { tenantId, projectId } }),
    )
    expect(pending).toMatchObject({
      outcomeState: 'OBSERVED',
      cleanupState: 'PENDING',
      accountingState: 'PENDING',
      result: expect.objectContaining({ summary: 'A signed entrance.' }),
      leaseToken: null,
    })
    await expect(invoke()).resolves.toMatchObject({ summary: 'A signed entrance.' })
    expect(upload).toHaveBeenCalledOnce()
    expect(generateContent).toHaveBeenCalledOnce()
    expect(budgetGate.settleExact).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledTimes(2)
    expect(new Set(remove.mock.calls.map(([call]) => call.name))).toEqual(
      new Set([pending.plannedProviderFileName]),
    )
    const receipt = await withTenantIsolationBypass(() =>
      db.mediaProviderOperation.findFirstOrThrow({ where: { tenantId, projectId } }),
    )
    expect(receipt).toMatchObject({
      outcomeState: 'OBSERVED',
      cleanupState: 'CONFIRMED',
      accountingState: 'SETTLED',
      result: expect.objectContaining({ summary: 'A signed entrance.' }),
    })
    await expect(
      withTenantIsolationBypass(() =>
        db.mediaProviderOperation.update({
          where: { id: receipt.id },
          data: { inputSha256: 'f'.repeat(64) },
        }),
      ),
    ).rejects.toThrow()
  })

  it('persists dispatch time rather than stale preparation time across the pricing boundary', async () => {
    const prepared = await prepareOperation({
      tenantId,
      venueId,
      projectId,
      uploadAttemptId,
      sourceId: 'video-boundary',
      provider: 'google',
      model: 'gemini-3.7-flash',
      method: 'boundary-fixture',
      inputSha256: 'd'.repeat(64),
      promptSha256: 'e'.repeat(64),
      extractionSchemaVersion: 'media-analysis-v1',
      plannedProviderFileName: `files/boundary-${suffix}`,
    })
    await withTenantIsolationBypass(() =>
      db.mediaProviderOperation.update({
        where: { id: prepared.id },
        data: { createdAt: new Date('2026-12-31T23:59:59.000Z') },
      }),
    )
    const claim = (await claimOperation({ id: prepared.id, tenantId }))!
    const invocationAt = new Date('2027-01-01T00:00:00.000Z')
    await markDispatched(
      { id: prepared.id, tenantId, leaseToken: claim.leaseToken, revision: claim.revision },
      'budget-boundary',
      invocationAt,
    )
    await expect(
      withTenantIsolationBypass(() =>
        db.mediaProviderOperation.findFirstOrThrow({
          where: { id: prepared.id, tenantId },
        }),
      ),
    ).resolves.toMatchObject({
      createdAt: new Date('2026-12-31T23:59:59.000Z'),
      dispatchedAt: invocationAt,
    })
  })

  it('retries the full ingestion job on the same generation without another provider dispatch', async () => {
    const processProjectId = `gemini-process-project-${suffix}`
    const processAttemptId = randomUUID()
    const objectKey = `media-provider-operation/${suffix}.zip`
    const archive = storedZip('walkthrough.mp4', Buffer.from('fixture-video-bytes'))
    const storage = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT!,
      region: process.env.STORAGE_REGION!,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
      },
    })
    await storage.send(new CreateBucketCommand({ Bucket: process.env.STORAGE_BUCKET! }))
    await storage.send(
      new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET!, Key: objectKey, Body: archive }),
    )
    await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.create({
        data: {
          id: processProjectId,
          tenantId,
          venueId,
          name: 'Gemini process recovery',
          createdBy: 'fixture',
          status: 'QUEUED',
          sourceObjectKey: objectKey,
          uploadAttemptId: processAttemptId,
          settings: { useGeminiVideoUnderstanding: true, transcribeAudio: false },
        },
      }),
    )
    const upload = vi.fn(async ({ config }: { config: { name: string } }) => ({
      name: config.name,
      uri: 'provider://process-fixture',
      mimeType: 'video/mp4',
      state: 'ACTIVE' as const,
    }))
    const generateContent = vi.fn(async () => ({
      text: JSON.stringify({
        summary: 'A walkthrough entrance.',
        visibleText: [],
        objects: [],
        spatialClues: [],
        uncertainties: [],
        observations: [],
      }),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    }))
    const remove = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('cleanup pending'), { status: 503 }))
      .mockResolvedValue({})
    setGeminiVideoClientForTesting({
      files: { upload, get: vi.fn(), delete: remove },
      models: { generateContent },
    } as GeminiVideoClient)
    setOpenAiMediaClientForTesting({
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    schemaVersion: 1,
                    places: [],
                    knowledgeEntries: [
                      {
                        title: 'Walkthrough evidence',
                        category: 'media-review',
                        content: 'A walkthrough entrance was observed.',
                        isEnabled: true,
                      },
                    ],
                    questions: [],
                    coverage: { evidenceSources: 1, notes: [] },
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          })),
        },
      },
      audio: { transcriptions: { create: vi.fn() } },
    } as unknown as OpenAiMediaClient)
    process.env.OPENAI_API_KEY = 'disposable-fixture-key'
    const jobPayload = {
      tenantId,
      venueId,
      projectId: processProjectId,
      uploadAttemptId: processAttemptId,
    }

    await expect(processMediaIngestionJob(jobPayload, 'receipt-process-1')).rejects.toThrow(
      'deletion could not be confirmed',
    )
    await expect(processMediaIngestionJob(jobPayload, 'receipt-process-2')).resolves.toBeUndefined()

    expect(upload).toHaveBeenCalledOnce()
    expect(generateContent).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledTimes(2)
    const [completed, receipt] = await withTenantIsolationBypass(() =>
      Promise.all([
        db.mediaIngestionProject.findFirstOrThrow({ where: { id: processProjectId, tenantId } }),
        db.mediaProviderOperation.findFirstOrThrow({
          where: { projectId: processProjectId, tenantId },
        }),
      ]),
    )
    expect(completed).toMatchObject({ status: 'READY_FOR_REVIEW', uploadAttemptId: null })
    expect(receipt).toMatchObject({
      uploadAttemptId: processAttemptId,
      outcomeState: 'OBSERVED',
      cleanupState: 'CONFIRMED',
      accountingState: 'SETTLED',
    })
  })
})
