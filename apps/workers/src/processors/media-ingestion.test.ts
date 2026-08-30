import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'

const mocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  mkdtemp: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdateMany: vi.fn(),
  assetUpsert: vi.fn(),
  rm: vi.fn(),
  updateJobRecord: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
  storageSend: vi.fn(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: mocks.mkdtemp, rm: mocks.rm }
})
vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
  assertVenueAiAvailable: vi.fn().mockResolvedValue(undefined),
  GlobalAiAdmissionError: class GlobalAiAdmissionError extends Error {
    name = 'GlobalAiAdmissionError'
    constructor(readonly code: string) {
      super('Global AI admission is unavailable')
    }
  },
  isAiAdmissionControlError: (error: unknown) =>
    error instanceof Error &&
    (error.name === 'GlobalAiAdmissionError' ||
      error.name === 'AiCostBudgetExceededError' ||
      error.name === 'AiCostBudgetUnavailableError' ||
      error.name === 'VenueUnavailableError'),
  db: {
    mediaIngestionProject: {
      findFirst: mocks.projectFindFirst,
      updateMany: mocks.projectUpdateMany,
    },
    mediaIngestionAsset: {
      upsert: mocks.assetUpsert,
    },
  },
  updateJobRecord: mocks.updateJobRecord,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
}))
vi.mock('@pathfinder/jobs', () => ({
  MEDIA_INGESTION_PROCESS_JOB: 'media-ingestion-process',
  MEDIA_INGESTION_QUEUE: 'test-media-ingestion',
}))
vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: class GetObjectCommand {},
  S3Client: class S3Client {
    send = mocks.storageSend
  },
}))

import { assignMediaSourceIds } from '../lib/media-source-id'
import {
  MediaAttemptDeadlineExceededError,
  MediaJobCancelledError,
} from '../lib/media-job-cancellation'
import {
  cleanupMediaWorkDir,
  downloadAndExtract,
  assertMediaSourceFilename,
  mediaSynthesisToVenuePackage,
  MediaGeneratedOutputCleanupError,
  MediaSynthesisSummaryBudget,
  parseMediaAnalysisResponse,
  parseMediaSynthesisResponse,
  persistMediaIngestionAsset,
  processMediaIngestionJob,
  withMediaGeneratedOutputDirectory,
} from './media-ingestion'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

const payload = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  projectId: 'project_1',
  uploadAttemptId: '11111111-1111-4111-8111-111111111111',
}
const project = {
  id: 'project_1',
  context: 'Context',
  mode: 'BALANCED',
  settings: {},
  sourceObjectKey: 'test/project.zip',
  status: 'QUEUED',
  uploadAttemptId: payload.uploadAttemptId,
  venue: { name: 'Test Venue' },
}

describe('media ingestion provider output validation', () => {
  it('rejects a media source path beyond the persisted review filename bound', () => {
    expect(() => assertMediaSourceFilename('x'.repeat(1_001))).toThrow(
      'Media source path exceeds the 1000-character safety limit.',
    )
    expect(() => assertMediaSourceFilename('x'.repeat(1_000))).not.toThrow()
  })

  it('accepts bounded analysis JSON wrapped in a markdown fence', () => {
    expect(
      parseMediaAnalysisResponse(`\`\`\`json
        {
          "summary": "A labeled entrance",
          "visibleText": ["North Hall"],
          "objects": [{"name": "door", "confidence": "confirmed"}],
          "spatialClues": ["Sign is above the entrance"],
          "uncertainties": []
        }
      \`\`\``),
    ).toEqual({
      summary: 'A labeled entrance',
      visibleText: ['North Hall'],
      objects: [{ name: 'door', confidence: 'confirmed' }],
      spatialClues: ['Sign is above the entrance'],
      uncertainties: [],
    })
  })

  it.each([
    ['invalid JSON', '{not-json'],
    [
      'missing fields',
      JSON.stringify({ summary: 'Incomplete', visibleText: [], objects: [], spatialClues: [] }),
    ],
    [
      'invalid confidence',
      JSON.stringify({
        summary: 'Bad confidence',
        visibleText: [],
        objects: [{ name: 'object', confidence: 'certain' }],
        spatialClues: [],
        uncertainties: [],
      }),
    ],
    [
      'oversized summary',
      JSON.stringify({
        summary: 'x'.repeat(50_001),
        visibleText: [],
        objects: [],
        spatialClues: [],
        uncertainties: [],
      }),
    ],
  ])('rejects %s analysis output', (_caseName, response) => {
    expect(() => parseMediaAnalysisResponse(response)).toThrow(/^Media analysis provider output/u)
  })

  it('accepts an import-compatible bounded synthesis draft', () => {
    const synthesis = parseMediaSynthesisResponse(
      JSON.stringify({
        schemaVersion: 1,
        places: [
          {
            name: 'North Hall',
            type: 'exhibit',
            itemType: 'exhibit',
            longDescription: 'A public exhibit hall.',
            tags: ['indoor'],
            importanceScore: 50,
          },
        ],
        knowledgeEntries: [
          {
            title: 'Hours',
            category: 'Operations',
            content: 'Open until five.',
            isEnabled: true,
          },
        ],
        questions: [{ id: 'Q-1', question: 'Is the hall accessible?' }],
        coverage: { evidenceSources: 1, notes: [] },
      }),
    )
    expect(synthesis).toMatchObject({ schemaVersion: 1, questions: [{ id: 'Q-1' }] })
    expect(VenuePackagePayloadV1.parse(mediaSynthesisToVenuePackage(synthesis))).toMatchObject({
      schemaVersion: 1,
      places: [{ name: 'North Hall' }],
    })
  })

  it.each([
    [
      'wrong schema version',
      {
        schemaVersion: 2,
        places: [],
        knowledgeEntries: [],
        questions: [],
        coverage: { evidenceSources: 0, notes: [] },
      },
    ],
    [
      'out-of-range importance',
      {
        schemaVersion: 1,
        places: [
          {
            name: 'Hall',
            type: 'exhibit',
            itemType: 'exhibit',
            longDescription: 'Description',
            tags: [],
            importanceScore: 101,
          },
        ],
        knowledgeEntries: [],
        questions: [],
        coverage: { evidenceSources: 0, notes: [] },
      },
    ],
    [
      'unexpected root field',
      {
        schemaVersion: 1,
        places: [],
        knowledgeEntries: [],
        questions: [],
        coverage: { evidenceSources: 0, notes: [] },
        rawProviderDebug: 'must not persist',
      },
    ],
    [
      'malformed question',
      {
        schemaVersion: 1,
        places: [],
        knowledgeEntries: [],
        questions: ['Missing an ID'],
        coverage: { evidenceSources: 0, notes: [] },
      },
    ],
    [
      'duplicate question IDs',
      {
        schemaVersion: 1,
        places: [{ name: 'Hall', type: 'exhibit' }],
        knowledgeEntries: [],
        questions: [
          { id: 'Q-1', question: 'First?' },
          { id: 'Q-1', question: 'Second?' },
        ],
        coverage: { evidenceSources: 1, notes: [] },
      },
    ],
    [
      'unexpected nested field',
      {
        schemaVersion: 1,
        places: [
          {
            name: 'Hall',
            type: 'exhibit',
            itemType: 'exhibit',
            longDescription: 'Description',
            tags: [],
            importanceScore: 50,
            rawProviderDebug: 'must not persist',
          },
        ],
        knowledgeEntries: [],
        questions: [],
        coverage: { evidenceSources: 1, notes: [] },
      },
    ],
    [
      'import-incompatible name length',
      {
        schemaVersion: 1,
        places: [
          {
            name: 'x'.repeat(201),
            type: 'exhibit',
            itemType: 'exhibit',
            longDescription: 'Description',
            tags: [],
            importanceScore: 50,
          },
        ],
        knowledgeEntries: [],
        questions: [],
        coverage: { evidenceSources: 1, notes: [] },
      },
    ],
    [
      'more than 500 total import entries',
      {
        schemaVersion: 1,
        places: [
          {
            name: 'Hall',
            type: 'exhibit',
            tags: [],
            importanceScore: 50,
          },
        ],
        knowledgeEntries: Array.from({ length: 500 }, (_, index) => ({
          title: `Entry ${index}`,
          category: 'General',
          content: 'Content',
          isEnabled: true,
        })),
        questions: [],
        coverage: { evidenceSources: 501, notes: [] },
      },
    ],
  ])('rejects synthesis output with %s', (_caseName, draft) => {
    expect(() => parseMediaSynthesisResponse(JSON.stringify(draft))).toThrow(
      /^Media synthesis provider output/u,
    )
  })

  it('rejects provider JSON beyond the nesting bound', () => {
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 14; depth++) nested = { child: nested }
    expect(() =>
      parseMediaSynthesisResponse(
        JSON.stringify({
          schemaVersion: 1,
          places: [],
          knowledgeEntries: [],
          questions: [{ id: 'Q-1', question: 'Nested?', nested }],
          coverage: { evidenceSources: 0, notes: [] },
        }),
      ),
    ).toThrow(/^Media synthesis provider output/u)
  })

  it('rejects batch summaries before cumulative provider output can exceed the memory budget', () => {
    const budget = new MediaSynthesisSummaryBudget()
    budget.retain({ summary: 'x'.repeat(600_000) })
    expect(() => budget.retain({ summary: 'y'.repeat(600_000) })).toThrow(
      'Media evidence summaries exceed the synthesis memory limit.',
    )
  })
})

describe('media ingestion archive cancellation', () => {
  it('interrupts a stalled object stream and normalizes the abort', async () => {
    const previous = {
      bucket: process.env.STORAGE_BUCKET,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
      region: process.env.STORAGE_REGION,
    }
    process.env.STORAGE_BUCKET = 'test-bucket'
    process.env.STORAGE_ACCESS_KEY_ID = 'test-access-key'
    process.env.STORAGE_SECRET_ACCESS_KEY = 'test-secret-key'
    process.env.STORAGE_REGION = 'us-east-1'
    const source = new PassThrough()
    mocks.storageSend.mockResolvedValueOnce({ Body: source })
    const controller = new AbortController()

    try {
      const result = downloadAndExtract('test/archive.zip', 'unused', controller.signal)
      await new Promise((resolve) => setImmediate(resolve))
      controller.abort()

      await expect(result).rejects.toBeInstanceOf(MediaJobCancelledError)
      expect(source.destroyed).toBe(true)
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        const key =
          name === 'bucket'
            ? 'STORAGE_BUCKET'
            : name === 'accessKeyId'
              ? 'STORAGE_ACCESS_KEY_ID'
              : name === 'secretAccessKey'
                ? 'STORAGE_SECRET_ACCESS_KEY'
                : 'STORAGE_REGION'
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('media ingestion lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.assetUpsert.mockResolvedValue({ id: 'asset_1' })
  })

  it('rejects a pre-aborted delivery without creating durable job state', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      processMediaIngestionJob(payload, 'bull_cancelled', controller.signal),
    ).rejects.toBeInstanceOf(MediaJobCancelledError)
    expect(mocks.writeJobRecord).not.toHaveBeenCalled()
    expect(mocks.projectFindFirst).not.toHaveBeenCalled()
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
  })

  it('records retryable failure and cleans temp data when cancellation follows the claim', async () => {
    const controller = new AbortController()
    mocks.projectFindFirst.mockResolvedValueOnce(project)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.mkdtemp.mockImplementationOnce(async () => {
      controller.abort()
      return 'C:/temp/media-cancelled'
    })
    mocks.rm.mockResolvedValueOnce(undefined)

    await expect(
      processMediaIngestionJob(payload, 'bull_cancelled', controller.signal),
    ).rejects.toBeInstanceOf(MediaJobCancelledError)

    expect(mocks.assetUpsert).not.toHaveBeenCalled()
    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: payload.projectId,
        tenantId: payload.tenantId,
        uploadAttemptId: payload.uploadAttemptId,
      },
      data: {
        status: 'FAILED',
        error: 'Media ingestion stopped after the worker lost its job lock.',
      },
    })
    expect(mocks.rm).toHaveBeenCalledWith('C:/temp/media-cancelled', {
      recursive: true,
      force: true,
    })
  })

  it('normalizes an aborted dependency error before retryable failure persistence', async () => {
    const controller = new AbortController()
    mocks.projectFindFirst.mockResolvedValueOnce(project)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.mkdtemp.mockImplementationOnce(async () => {
      controller.abort()
      throw new DOMException('provider-specific abort', 'AbortError')
    })

    await expect(
      processMediaIngestionJob(payload, 'bull_cancelled_dependency', controller.signal),
    ).rejects.toBeInstanceOf(MediaJobCancelledError)
    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: payload.projectId,
        tenantId: payload.tenantId,
        uploadAttemptId: payload.uploadAttemptId,
      },
      data: {
        status: 'FAILED',
        error: 'Media ingestion stopped after the worker lost its job lock.',
      },
    })
    expect(mocks.rm).not.toHaveBeenCalled()
  })

  it('preserves a retryable whole-attempt deadline through failure persistence and cleanup', async () => {
    const controller = new AbortController()
    const deadline = new MediaAttemptDeadlineExceededError(21_600_000)
    mocks.projectFindFirst.mockResolvedValueOnce(project)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.mkdtemp.mockImplementationOnce(async () => {
      controller.abort(deadline)
      return 'C:/temp/media-deadline'
    })
    mocks.rm.mockResolvedValueOnce(undefined)

    await expect(
      processMediaIngestionJob(payload, 'bull_deadline', controller.signal),
    ).rejects.toBe(deadline)
    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: payload.projectId,
        tenantId: payload.tenantId,
        uploadAttemptId: payload.uploadAttemptId,
      },
      data: {
        status: 'FAILED',
        error: 'Media ingestion attempt exceeded its 21600000-millisecond execution safety limit.',
      },
    })
    expect(mocks.rm).toHaveBeenCalledWith('C:/temp/media-deadline', {
      recursive: true,
      force: true,
    })
  })

  it('treats a stale generation as complete without claiming or starting provider work', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      ...project,
      uploadAttemptId: '22222222-2222-4222-8222-222222222222',
    })

    await expect(processMediaIngestionJob(payload, 'bull_stale')).resolves.toBeUndefined()

    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('record_1', { status: 'COMPLETE' })
  })

  it('claims a retained legacy payload only against the null generation', async () => {
    const legacyPayload = {
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      projectId: payload.projectId,
    } as unknown as Parameters<typeof processMediaIngestionJob>[0]
    mocks.projectFindFirst.mockResolvedValueOnce({ ...project, uploadAttemptId: null })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(processMediaIngestionJob(legacyPayload, 'bull_legacy')).resolves.toBeUndefined()

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        uploadAttemptId: null,
        status: { in: ['QUEUED', 'FAILED'] },
      },
      data: { status: 'INVENTORYING', stage: 'inventory', progress: 3, error: null },
    })
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
  })

  it('does not let a retained legacy payload claim a newer non-null generation', async () => {
    const legacyPayload = {
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      projectId: payload.projectId,
    } as unknown as Parameters<typeof processMediaIngestionJob>[0]
    mocks.projectFindFirst.mockResolvedValueOnce(project)

    await expect(processMediaIngestionJob(legacyPayload, 'bull_legacy')).resolves.toBeUndefined()

    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('record_1', { status: 'COMPLETE' })
  })

  it('scopes a legacy failure write to null so a new generation wins the race', async () => {
    const legacyPayload = {
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      projectId: payload.projectId,
    } as unknown as Parameters<typeof processMediaIngestionJob>[0]
    mocks.projectFindFirst.mockResolvedValueOnce({ ...project, uploadAttemptId: null })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    mocks.mkdtemp.mockRejectedValueOnce(new Error('temp unavailable'))

    await expect(processMediaIngestionJob(legacyPayload, 'bull_legacy')).rejects.toThrow(
      'temp unavailable',
    )

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'project_1', tenantId: 'tenant_1', uploadAttemptId: null },
      data: { status: 'FAILED', error: 'temp unavailable' },
    })
  })

  it('completes a duplicate delivery without provider or temp work when claim is unavailable', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(project)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(processMediaIngestionJob(payload, 'bull_1')).resolves.toBeUndefined()

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        uploadAttemptId: payload.uploadAttemptId,
        status: { in: ['QUEUED', 'FAILED'] },
      },
      data: { status: 'INVENTORYING', stage: 'inventory', progress: 3, error: null },
    })
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('record_1', { status: 'COMPLETE' })
  })

  it('marks project and job FAILED when temp-directory creation fails after claim', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(project)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.mkdtemp.mockRejectedValueOnce(new Error('temp unavailable'))

    await expect(processMediaIngestionJob(payload, 'bull_1')).rejects.toThrow('temp unavailable')

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        uploadAttemptId: payload.uploadAttemptId,
      },
      data: { status: 'FAILED', error: 'temp unavailable' },
    })
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('record_1', {
      status: 'FAILED',
      error: 'JOB_ATTEMPTS_EXHAUSTED',
      attemptNumber: 1,
      maxAttempts: 1,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
    })
    expect(mocks.rm).not.toHaveBeenCalled()
  })

  it('fenced-restores QUEUED without recording failure when its venue pauses after claim', async () => {
    const pause = Object.assign(new Error('venue unavailable'), { name: 'VenueUnavailableError' })
    mocks.projectFindFirst.mockResolvedValueOnce(project)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.mkdtemp.mockRejectedValueOnce(pause)

    await expect(processMediaIngestionJob(payload, 'bull_paused')).rejects.toBe(pause)

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        uploadAttemptId: payload.uploadAttemptId,
        status: { in: ['INVENTORYING', 'ANALYZING', 'SYNTHESIZING'] },
      },
      data: { status: 'QUEUED', stage: 'inventory', progress: 0, error: null },
    })
    expect(mocks.updateJobRecord).not.toHaveBeenCalled()
  })

  it('allows a Bull retry to reclaim FAILED only for the same generation', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({ ...project, status: 'FAILED' })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.mkdtemp.mockRejectedValueOnce(new Error('temp unavailable'))

    await expect(processMediaIngestionJob(payload, 'bull_retry')).rejects.toThrow(
      'temp unavailable',
    )

    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        uploadAttemptId: payload.uploadAttemptId,
        status: { in: ['QUEUED', 'FAILED'] },
      },
      data: { status: 'INVENTORYING', stage: 'inventory', progress: 3, error: null },
    })
    expect(mocks.mkdtemp).toHaveBeenCalledOnce()
  })

  it('logs and absorbs cleanup failure so it cannot mask the primary outcome', async () => {
    mocks.rm.mockRejectedValueOnce(new Error('file busy'))
    await expect(cleanupMediaWorkDir('C:/temp/project', 'project_1')).resolves.toBeUndefined()
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.cleanup.failed',
      projectId: 'project_1',
      error: 'file busy',
    })
  })

  it('removes one video output directory before returning its analysis', async () => {
    mocks.rm.mockResolvedValueOnce(undefined)
    await expect(
      withMediaGeneratedOutputDirectory('C:/temp/project/frames-1', async () => 'analysis'),
    ).resolves.toBe('analysis')
    expect(mocks.rm).toHaveBeenCalledWith('C:/temp/project/frames-1', {
      recursive: true,
      force: true,
    })
  })

  it('stops unrecoverably and preserves both failures when video cleanup also fails', async () => {
    const analysisError = new Error('analysis failed')
    const cleanupError = new Error('directory busy')
    mocks.rm.mockRejectedValueOnce(cleanupError)

    const result = withMediaGeneratedOutputDirectory('C:/temp/project/frames-1', async () => {
      throw analysisError
    })
    await expect(result).rejects.toBeInstanceOf(MediaGeneratedOutputCleanupError)
    await expect(result).rejects.toMatchObject({ errors: [analysisError, cleanupError] })
  })

  it('persists colliding archive labels as distinct, correctly paired assets across retries', async () => {
    const files = assignMediaSourceIds([
      { filename: 'a/P001-front.jpg', bytes: 101 },
      { filename: 'b/P001-label.jpg', bytes: 202 },
    ])
    const analyses = [
      { summary: 'front', visibleText: [], objects: [], spatialClues: [], uncertainties: [] },
      { summary: 'label', visibleText: [], objects: [], spatialClues: [], uncertainties: [] },
    ]

    for (let replay = 0; replay < 2; replay++) {
      for (let index = 0; index < files.length; index++) {
        await persistMediaIngestionAsset({
          tenantId: payload.tenantId,
          projectId: payload.projectId,
          sourceObjectKey: project.sourceObjectKey,
          file: files[index]!,
          mediaType: 'IMAGE',
          sha256: `hash-${index}`,
          outcome: { status: 'COMPLETE', analysis: analyses[index]! },
        })
      }
    }

    const firstSourceId = files[0]!.sourceId
    const secondSourceId = files[1]!.sourceId
    expect(firstSourceId).toBe('P001')
    expect(secondSourceId).toMatch(/^P001-00002-[0-9a-f]{12}$/u)
    expect(secondSourceId).not.toBe(firstSourceId)
    expect(mocks.assetUpsert).toHaveBeenCalledTimes(4)

    for (const callOffset of [0, 2]) {
      expect(mocks.assetUpsert).toHaveBeenNthCalledWith(callOffset + 1, {
        where: { projectId_sourceId: { projectId: 'project_1', sourceId: firstSourceId } },
        create: expect.objectContaining({
          sourceId: firstSourceId,
          filename: 'a/P001-front.jpg',
          objectKey: 'test/project.zip#a/P001-front.jpg',
          bytes: 101n,
          analysis: analyses[0],
        }),
        update: expect.objectContaining({
          filename: 'a/P001-front.jpg',
          objectKey: 'test/project.zip#a/P001-front.jpg',
          bytes: 101n,
          analysis: analyses[0],
        }),
      })
      expect(mocks.assetUpsert).toHaveBeenNthCalledWith(callOffset + 2, {
        where: { projectId_sourceId: { projectId: 'project_1', sourceId: secondSourceId } },
        create: expect.objectContaining({
          sourceId: secondSourceId,
          filename: 'b/P001-label.jpg',
          objectKey: 'test/project.zip#b/P001-label.jpg',
          bytes: 202n,
          analysis: analyses[1],
        }),
        update: expect.objectContaining({
          filename: 'b/P001-label.jpg',
          objectKey: 'test/project.zip#b/P001-label.jpg',
          bytes: 202n,
          analysis: analyses[1],
        }),
      })
    }
  })
})
