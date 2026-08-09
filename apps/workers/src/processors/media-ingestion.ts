import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Writable, type Readable } from 'node:stream'

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import OpenAI from 'openai'
import sharp from 'sharp'
import * as unzipper from 'unzipper'
import ffmpegPath from 'ffmpeg-static'
import { UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import {
  MEDIA_SOURCE_FILENAME_LIMIT,
  VENUE_PACKAGE_ITEM_LIMIT,
  VenuePackagePayloadV1,
  VenuePackagePayloadV1Object,
} from '@pathfinder/contracts'

import { logger } from '@pathfinder/config'
import {
  assertGlobalAiAvailable,
  db,
  GlobalAiAdmissionError,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import {
  MEDIA_INGESTION_PROCESS_JOB,
  MEDIA_INGESTION_QUEUE,
  type MediaIngestionJobPayload,
} from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'
import {
  forwardReadableErrors,
  jsonArrayExceedsCharacterLimit,
  MediaArchiveByteBudget,
  MediaTextRetentionBudget,
  readUtf8TextPrefix,
} from '../lib/media-archive'
import { assignMediaSourceIds } from '../lib/media-source-id'
import { runBoundedStreamingLeafProcess } from '../lib/bounded-streaming-process'
import {
  MediaGeneratedOutputBudget,
  MAX_MEDIA_GENERATED_OUTPUT_BYTES,
} from '../lib/media-attempt-limits'
import { JpegFrameWriter, MAX_GENERATED_VIDEO_FRAMES } from '../lib/jpeg-frame-stream'
import {
  assertMediaJobActive,
  MediaJobCancelledError,
  normalizeMediaJobError,
} from '../lib/media-job-cancellation'
import {
  executeMediaProviderOperation,
  reserveMediaProviderOperation,
} from '../lib/media-provider-budget'

const MAX_FILES = 10_000
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024 * 1024
const MAX_RETAINED_TEXT_CHARACTERS = 250_000
const MAX_TEXT_CHARACTERS_PER_FILE = 100_000
const MAX_SYNTHESIS_JSON_CHARACTERS = 1_000_000
const MAX_PROVIDER_JSON_CHARACTERS = 1_000_000
const MAX_PROVIDER_JSON_DEPTH = 12
const MAX_PROVIDER_JSON_NODES = 50_000
const MAX_PROVIDER_OBJECT_PROPERTIES = 1_000
const MAX_PROVIDER_ARRAY_ITEMS = 10_000
const MAX_PROVIDER_KEY_CHARACTERS = 200
const MAX_PROVIDER_STRING_CHARACTERS = 100_000
const FFMPEG_MAX_OUTPUT_BYTES = 64 * 1024
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff'])
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm'])
const audioExtensions = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg'])
const textExtensions = new Set(['.txt', '.md', '.csv', '.json'])
type ReserveProviderOperation = () => Promise<void>

export class MediaSynthesisSummaryBudget {
  private retainedCharacters = 2 // Opening and closing JSON array delimiters.
  private retainedItems = 0

  retain(summary: unknown): void {
    const separatorCharacters = this.retainedItems > 0 ? 1 : 0
    const nextCharacters = JSON.stringify(summary).length + separatorCharacters
    if (this.retainedCharacters + nextCharacters > MAX_SYNTHESIS_JSON_CHARACTERS) {
      throw new Error('Media evidence summaries exceed the synthesis memory limit.')
    }
    this.retainedCharacters += nextCharacters
    this.retainedItems += 1
  }
}

export async function cleanupMediaWorkDir(workDir: string, projectId: string): Promise<void> {
  try {
    await rm(workDir, { recursive: true, force: true })
  } catch (error) {
    logger.warn({
      action: 'media-ingestion.cleanup.failed',
      projectId,
      error: error instanceof Error ? error.message : 'Unknown cleanup error',
    })
  }
}

export class MediaGeneratedOutputCleanupError extends UnrecoverableError {
  constructor(readonly errors: readonly unknown[]) {
    super('Media generated-file cleanup failed; the job stopped to protect temporary storage.')
  }
}

export async function withMediaGeneratedOutputDirectory<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await operation() }
  } catch (error) {
    outcome = { ok: false, error }
  }
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (cleanupError) {
    throw new MediaGeneratedOutputCleanupError(
      outcome.ok ? [cleanupError] : [outcome.error, cleanupError],
    )
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

type Analysis = {
  summary: string
  visibleText: string[]
  objects: Array<{ name: string; confidence: 'confirmed' | 'probable' | 'unverified' }>
  spatialClues: string[]
  uncertainties: string[]
}

const analysisSchema = z
  .object({
    summary: z.string().min(1).max(50_000),
    visibleText: z.array(z.string().max(10_000)).max(1_000),
    objects: z
      .array(
        z
          .object({
            name: z.string().min(1).max(1_000),
            confidence: z.enum(['confirmed', 'probable', 'unverified']),
          })
          .strict(),
      )
      .max(1_000),
    spatialClues: z.array(z.string().max(10_000)).max(1_000),
    uncertainties: z.array(z.string().max(10_000)).max(1_000),
  })
  .strict()

const synthesisQuestionSchema = z
  .object({
    id: z.string().min(1).max(200),
    question: z.string().min(1).max(10_000),
  })
  .strict()

const synthesisCoverageSchema = z
  .object({
    evidenceSources: z.number().int().min(0).max(MAX_FILES),
    notes: z.array(z.string().max(1_000)).max(100),
  })
  .strict()

const synthesisDraftSchema = VenuePackagePayloadV1Object.extend({
  questions: z.array(synthesisQuestionSchema).max(500),
  coverage: synthesisCoverageSchema,
})
  .strict()
  .superRefine((draft, context) => {
    if (draft.places.length + draft.knowledgeEntries.length > VENUE_PACKAGE_ITEM_LIMIT) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: VENUE_PACKAGE_ITEM_LIMIT,
        type: 'array',
        inclusive: true,
        message: 'A media synthesis draft can contain at most 500 total import entries.',
      })
    }
    const questionIds = new Set<string>()
    draft.questions.forEach((question, index) => {
      if (questionIds.has(question.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['questions', index, 'id'],
          message: 'Media synthesis question IDs must be unique.',
        })
      }
      questionIds.add(question.id)
    })
  })

type MediaType = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT'

type PersistMediaIngestionAssetParams = {
  tenantId: string
  projectId: string
  sourceObjectKey: string
  file: { filename: string; bytes: number; sourceId: string }
  mediaType: MediaType
  sha256: string
  signal?: AbortSignal
  outcome: { status: 'COMPLETE'; analysis: Analysis } | { status: 'FAILED'; error: string }
}

export async function persistMediaIngestionAsset(
  params: PersistMediaIngestionAssetParams,
): Promise<void> {
  assertMediaJobActive(params.signal)
  const identity = {
    filename: params.file.filename,
    mediaType: params.mediaType,
    objectKey: `${params.sourceObjectKey}#${params.file.filename}`,
    bytes: BigInt(params.file.bytes),
    sha256: params.sha256,
  }

  await withTenantIsolationBypass(() =>
    db.mediaIngestionAsset.upsert({
      where: {
        projectId_sourceId: { projectId: params.projectId, sourceId: params.file.sourceId },
      },
      create: {
        tenantId: params.tenantId,
        projectId: params.projectId,
        sourceId: params.file.sourceId,
        ...identity,
        status: params.outcome.status,
        ...(params.outcome.status === 'COMPLETE'
          ? { analysis: params.outcome.analysis }
          : { error: params.outcome.error }),
      },
      update: {
        ...identity,
        status: params.outcome.status,
        ...(params.outcome.status === 'COMPLETE'
          ? { analysis: params.outcome.analysis, error: null }
          : { error: params.outcome.error }),
      },
    }),
  )
}

function storageClient() {
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY
  const region = process.env.STORAGE_REGION
  if (!accessKeyId || !secretAccessKey || !region)
    throw new Error('Media storage is not configured.')
  return new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    ...(process.env.STORAGE_ENDPOINT
      ? { endpoint: process.env.STORAGE_ENDPOINT, forcePathStyle: true }
      : {}),
  })
}

function classify(filename: string): MediaType | null {
  const extension = extname(filename).toLowerCase()
  if (imageExtensions.has(extension)) return 'IMAGE'
  if (videoExtensions.has(extension)) return 'VIDEO'
  if (audioExtensions.has(extension)) return 'AUDIO'
  if (textExtensions.has(extension) || extension === '.pdf') return 'DOCUMENT'
  return null
}

export function assertMediaSourceFilename(filename: string): void {
  if (filename.length > MEDIA_SOURCE_FILENAME_LIMIT) {
    throw new Error(
      `Media source path exceeds the ${MEDIA_SOURCE_FILENAME_LIMIT}-character safety limit.`,
    )
  }
}

function unwrapProviderJson(text: string): string {
  const unwrapped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  if (unwrapped.length > MAX_PROVIDER_JSON_CHARACTERS) {
    throw new Error('Provider JSON exceeded the response size limit.')
  }
  return unwrapped
}

function assertBoundedProviderJson(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (nodes > MAX_PROVIDER_JSON_NODES) {
      throw new Error('Provider JSON exceeded the structural node limit.')
    }
    if (current.depth > MAX_PROVIDER_JSON_DEPTH) {
      throw new Error('Provider JSON exceeded the nesting limit.')
    }
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_PROVIDER_STRING_CHARACTERS) {
        throw new Error('Provider JSON contained an oversized string.')
      }
      continue
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value))
        throw new Error('Provider JSON contained a nonfinite number.')
      continue
    }
    if (current.value === null || typeof current.value === 'boolean') continue
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_PROVIDER_ARRAY_ITEMS) {
        throw new Error('Provider JSON exceeded the array item limit.')
      }
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 })
      continue
    }
    if (typeof current.value === 'object') {
      const entries = Object.entries(current.value)
      if (entries.length > MAX_PROVIDER_OBJECT_PROPERTIES) {
        throw new Error('Provider JSON exceeded the object property limit.')
      }
      for (const [key, item] of entries) {
        if (key.length > MAX_PROVIDER_KEY_CHARACTERS) {
          throw new Error('Provider JSON contained an oversized property name.')
        }
        stack.push({ value: item, depth: current.depth + 1 })
      }
      continue
    }
    throw new Error('Provider JSON contained an unsupported value.')
  }
}

function parseProviderJson<TSchema extends z.ZodTypeAny>(
  text: string,
  schema: TSchema,
  label: string,
): z.output<TSchema> {
  let value: unknown
  try {
    value = JSON.parse(unwrapProviderJson(text))
    assertBoundedProviderJson(value)
  } catch {
    throw new Error(`${label} was not valid bounded JSON.`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`${label} did not match the required schema.`)
  return parsed.data
}

export function parseMediaAnalysisResponse(text: string): Analysis {
  return parseProviderJson(text, analysisSchema, 'Media analysis provider output')
}

export function parseMediaSynthesisResponse(text: string): z.infer<typeof synthesisDraftSchema> {
  return parseProviderJson(text, synthesisDraftSchema, 'Media synthesis provider output')
}

export function mediaSynthesisToVenuePackage(
  synthesis: z.infer<typeof synthesisDraftSchema>,
): z.infer<typeof VenuePackagePayloadV1> {
  return VenuePackagePayloadV1.parse({
    schemaVersion: synthesis.schemaVersion,
    places: synthesis.places,
    knowledgeEntries: synthesis.knowledgeEntries,
  })
}

function emptyAnalysis(summary: string, uncertainty?: string): Analysis {
  return {
    summary,
    visibleText: [],
    objects: [],
    spatialClues: [],
    uncertainties: uncertainty ? [uncertainty] : [],
  }
}

async function analyzeImage(
  openai: OpenAI,
  reserveProviderOperation: ReserveProviderOperation,
  generatedOutputBudget: MediaGeneratedOutputBudget,
  filePath: string,
  sourceId: string,
  context: string,
  mode: string,
  signal?: AbortSignal,
): Promise<Analysis> {
  assertMediaJobActive(signal)
  const jpeg = await sharp(filePath)
    .rotate()
    .resize({ width: mode === 'FORENSIC' ? 2200 : 1600, height: 2200, fit: 'inside' })
    .jpeg({ quality: mode === 'ECONOMY' ? 72 : 84 })
    .toBuffer()
  assertMediaJobActive(signal)
  generatedOutputBudget.consume(jpeg.byteLength)
  const response = await executeMediaProviderOperation(
    () => assertGlobalAiAvailable(db),
    reserveProviderOperation,
    () =>
      openai.chat.completions.create(
        {
          model: process.env.MEDIA_ANALYSIS_MODEL ?? 'gpt-5.6-luna',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are a forensic venue-documentation analyst. Report only what this image supports. Transcribe readable labels verbatim, including apparent errors. Never identify an object from shape alone. Separate confirmed, probable, and unverified identifications. Return JSON with summary, visibleText (string[]), objects ({name, confidence}[]), spatialClues (string[]), and uncertainties (string[]).',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Source ${sourceId}. Project context (context is not visual evidence):\n${context.slice(0, 12_000)}`,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
                    detail: mode === 'FORENSIC' ? 'high' : 'low',
                  },
                },
              ],
            },
          ],
        },
        signal ? { signal } : undefined,
      ),
    () => assertMediaJobActive(signal),
  )
  assertMediaJobActive(signal)
  const text = response.choices[0]?.message.content
  if (!text) throw new Error(`No visual analysis returned for ${sourceId}.`)
  return parseMediaAnalysisResponse(text)
}

async function transcribe(
  openai: OpenAI,
  reserveProviderOperation: ReserveProviderOperation,
  filePath: string,
  signal?: AbortSignal,
): Promise<Analysis> {
  assertMediaJobActive(signal)
  const result = await executeMediaProviderOperation(
    () => assertGlobalAiAvailable(db),
    reserveProviderOperation,
    () =>
      openai.audio.transcriptions.create(
        {
          file: createReadStream(filePath),
          model: process.env.MEDIA_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
        },
        signal ? { signal } : undefined,
      ),
    () => assertMediaJobActive(signal),
  )
  assertMediaJobActive(signal)
  return emptyAnalysis(result.text)
}

async function extractVideoFrames(
  filePath: string,
  outputDir: string,
  interval: number,
  generatedOutputBudget: MediaGeneratedOutputBudget,
  signal?: AbortSignal,
) {
  assertMediaJobActive(signal)
  if (!ffmpegPath) throw new Error('ffmpeg is unavailable in this worker build.')
  const executable = ffmpegPath
  await mkdir(outputDir, { recursive: true })
  const writer = new JpegFrameWriter({
    budget: generatedOutputBudget,
    directory: outputDir,
    maxFrames: MAX_GENERATED_VIDEO_FRAMES,
  })
  await runBoundedStreamingLeafProcess(
    executable,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-vf',
      `fps=1/${interval},scale=w='min(1600,iw)':h='min(2200,ih)':force_original_aspect_ratio=decrease`,
      '-frames:v',
      String(MAX_GENERATED_VIDEO_FRAMES),
      '-q:v',
      '2',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ],
    {
      consumeStdout: (stdout, processSignal) => pipeline(stdout, writer, { signal: processSignal }),
      label: 'ffmpeg frame extraction',
      maxStderrBytes: FFMPEG_MAX_OUTPUT_BYTES,
      ...(signal ? { signal } : {}),
      timeoutMs: FFMPEG_TIMEOUT_MS,
    },
  )
  assertMediaJobActive(signal)
  return [...writer.filenames]
}

async function extractVideoAudio(
  filePath: string,
  outputPath: string,
  generatedOutputBudget: MediaGeneratedOutputBudget,
  signal?: AbortSignal,
) {
  assertMediaJobActive(signal)
  if (!ffmpegPath) throw new Error('ffmpeg is unavailable in this worker build.')
  const executable = ffmpegPath
  await runBoundedStreamingLeafProcess(
    executable,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '48k',
      '-f',
      'mp3',
      'pipe:1',
    ],
    {
      consumeStdout: (stdout, processSignal) =>
        pipeline(
          stdout,
          generatedOutputBudget.createTransform(),
          createWriteStream(outputPath, { flags: 'wx' }),
          { signal: processSignal },
        ),
      label: 'ffmpeg audio extraction',
      maxStderrBytes: FFMPEG_MAX_OUTPUT_BYTES,
      ...(signal ? { signal } : {}),
      timeoutMs: FFMPEG_TIMEOUT_MS,
    },
  )
  assertMediaJobActive(signal)
}

async function sha256File(filePath: string, signal?: AbortSignal) {
  assertMediaJobActive(signal)
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, signal ? { signal } : undefined)
  for await (const chunk of stream) {
    assertMediaJobActive(signal)
    hash.update(chunk as Buffer)
  }
  assertMediaJobActive(signal)
  return hash.digest('hex')
}

export async function downloadAndExtract(
  objectKey: string,
  destination: string,
  signal?: AbortSignal,
) {
  assertMediaJobActive(signal)
  const bucket = process.env.STORAGE_BUCKET
  if (!bucket) throw new Error('STORAGE_BUCKET is not configured.')
  const response = await storageClient().send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    signal ? { abortSignal: signal } : undefined,
  )
  assertMediaJobActive(signal)
  if (!response.Body) throw new Error('The uploaded archive is empty.')
  const source = response.Body as unknown as Readable
  const zip = unzipper.Parse({ forceStream: true })
  const detachSourceErrorForwarder = forwardReadableErrors(source, zip)
  source.pipe(zip)
  const extracted: Array<{ filename: string; path: string; bytes: number }> = []
  const byteBudget = new MediaArchiveByteBudget(MAX_EXPANDED_BYTES)
  let entriesSeen = 0
  let activeEntry: unzipper.Entry | null = null
  const abortStreams = () => {
    const cancellation = new MediaJobCancelledError()
    activeEntry?.destroy(cancellation)
    zip.destroy(cancellation)
    source.destroy(cancellation)
  }
  signal?.addEventListener('abort', abortStreams, { once: true })
  if (signal?.aborted) abortStreams()

  try {
    assertMediaJobActive(signal)
    for await (const rawEntry of zip) {
      assertMediaJobActive(signal)
      const entry = rawEntry as unzipper.Entry
      activeEntry = entry
      entriesSeen++
      if (entriesSeen > MAX_FILES) throw new Error(`Archive exceeds ${MAX_FILES} entries.`)
      if (entry.type === 'Directory') {
        entry.autodrain()
        activeEntry = null
        continue
      }
      const declaredBytes = Number(
        (entry.vars as typeof entry.vars & { uncompressedSize?: number }).uncompressedSize ?? 0,
      )
      if (
        declaredBytes > MAX_EXPANDED_BYTES ||
        byteBudget.totalBytes + declaredBytes > MAX_EXPANDED_BYTES
      ) {
        throw new Error('Archive declares more than the 20 GB expanded-size safety limit.')
      }
      const originalName = entry.path.replace(/\\/g, '/')
      const cleanName = basename(originalName)
      const mediaType = classify(cleanName)
      if (mediaType) assertMediaSourceFilename(originalName)
      const counter = byteBudget.createEntryCounter()
      if (!mediaType || !cleanName || cleanName.startsWith('.')) {
        const discard = new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        })
        if (signal) await pipeline(entry, counter, discard, { signal })
        else await pipeline(entry, counter, discard)
        activeEntry = null
        continue
      }
      const target = join(
        destination,
        `${String(extracted.length + 1).padStart(5, '0')}-${cleanName}`,
      )
      const output = createWriteStream(target, { flags: 'wx' })
      if (signal) await pipeline(entry, counter, output, { signal })
      else await pipeline(entry, counter, output)
      extracted.push({ filename: originalName, path: target, bytes: counter.bytes })
      activeEntry = null
    }
  } catch (caughtError) {
    activeEntry?.destroy()
    zip.destroy()
    source.destroy()
    throw normalizeMediaJobError(caughtError, signal)
  } finally {
    signal?.removeEventListener('abort', abortStreams)
    detachSourceErrorForwarder()
  }
  assertMediaJobActive(signal)
  return extracted
}

async function synthesize(
  openai: OpenAI,
  reserveProviderOperation: ReserveProviderOperation,
  venueName: string,
  context: string,
  analyses: unknown[],
  signal?: AbortSignal,
) {
  assertMediaJobActive(signal)
  let evidence: unknown[] = analyses
  if (jsonArrayExceedsCharacterLimit(evidence, MAX_RETAINED_TEXT_CHARACTERS)) {
    const summaries: unknown[] = []
    const summaryBudget = new MediaSynthesisSummaryBudget()
    for (let index = 0; index < evidence.length; index += 35) {
      assertMediaJobActive(signal)
      const batch = evidence.slice(index, index + 35)
      if (jsonArrayExceedsCharacterLimit(batch, MAX_SYNTHESIS_JSON_CHARACTERS)) {
        throw new Error('Media evidence batch exceeds the synthesis memory limit.')
      }
      const response = await executeMediaProviderOperation(
        () => assertGlobalAiAvailable(db),
        reserveProviderOperation,
        () =>
          openai.chat.completions.create(
            {
              model:
                process.env.MEDIA_SYNTHESIS_MODEL ??
                process.env.MEDIA_ANALYSIS_MODEL ??
                'gpt-5.6-luna',
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content:
                    'Condense this evidence batch into JSON while preserving every named object, verbatim label fact, source ID, spatial clue, contradiction, and uncertainty. Merge nothing unless the evidence explicitly establishes a duplicate.',
                },
                { role: 'user', content: JSON.stringify(batch) },
              ],
            },
            signal ? { signal } : undefined,
          ),
        () => assertMediaJobActive(signal),
      )
      assertMediaJobActive(signal)
      const text = response.choices[0]?.message.content
      if (!text) throw new Error('No batch evidence summary was returned.')
      const summary = parseProviderJson(
        text,
        z.record(z.unknown()),
        'Media batch-summary provider output',
      )
      summaryBudget.retain(summary)
      summaries.push(summary)
    }
    evidence = summaries
  }
  if (jsonArrayExceedsCharacterLimit(evidence, MAX_SYNTHESIS_JSON_CHARACTERS)) {
    throw new Error('Media evidence exceeds the synthesis memory limit.')
  }
  const compact = JSON.stringify(evidence)
  assertMediaJobActive(signal)
  const response = await executeMediaProviderOperation(
    () => assertGlobalAiAvailable(db),
    reserveProviderOperation,
    () =>
      openai.chat.completions.create(
        {
          model:
            process.env.MEDIA_SYNTHESIS_MODEL ?? process.env.MEDIA_ANALYSIS_MODEL ?? 'gpt-5.6-luna',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Build draft PathFinder import JSON from evidence summaries. Return exactly schemaVersion 1, places, knowledgeEntries, questions, and coverage. Every place needs name (max 200 characters), type, tags, and importanceScore (integer 0-100); optionally include itemType (physical_place, exhibit, room, sculpture, service_step, faq, amenity, policy, activity, or general_info), shortDescription (max 500), longDescription (max 2000), areaName, hours, photoUrl, or paired lat/lng only when supported. Every knowledge entry needs title (max 200), category (max 100), content (max 5000), and isEnabled. Return at most 500 total places plus knowledge entries, and at most 500 questions. Every question must contain only a stable id and question string. Coverage must contain exactly evidenceSources (a nonnegative integer) and notes (a string array). Do not silently resolve conflicts, merge uncertain objects, or treat project context as direct observation. Put ambiguity that could change the guide in questions.',
            },
            {
              role: 'user',
              content: `Venue: ${venueName}\nOperator context:\n${context.slice(0, 12_000)}\n\nEvidence summaries:\n${compact}`,
            },
          ],
        },
        signal ? { signal } : undefined,
      ),
    () => assertMediaJobActive(signal),
  )
  assertMediaJobActive(signal)
  const text = response.choices[0]?.message.content
  if (!text) throw new Error('No synthesis result was returned.')
  return parseMediaSynthesisResponse(text)
}

export async function processMediaIngestionJob(
  payload: MediaIngestionJobPayload,
  executionInput?: JobExecutionInput,
  signal?: AbortSignal,
) {
  assertMediaJobActive(signal)
  const generatedOutputBudget = new MediaGeneratedOutputBudget(MAX_MEDIA_GENERATED_OUTPUT_BYTES)
  // Jobs retained from before generation-scoped payloads have no attempt ID.
  // Treat them as the legacy null generation so they can never claim newer work.
  const uploadAttemptId = payload.uploadAttemptId ?? null
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()
  const recordId = await writeJobRecord({
    queue: MEDIA_INGESTION_QUEUE,
    jobName: MEDIA_INGESTION_PROCESS_JOB,
    ...(execution.bullJobId !== undefined ? { bullJobId: execution.bullJobId } : {}),
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload,
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  let workDir: string | null = null

  try {
    assertMediaJobActive(signal)
    const project = await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.findFirst({
        where: { id: payload.projectId, tenantId: payload.tenantId, venueId: payload.venueId },
        select: {
          id: true,
          context: true,
          mode: true,
          settings: true,
          sourceObjectKey: true,
          status: true,
          uploadAttemptId: true,
          venue: { select: { name: true } },
        },
      }),
    )
    assertMediaJobActive(signal)
    if (!project || project.uploadAttemptId !== uploadAttemptId) {
      await updateJobRecord(recordId, { status: 'COMPLETE' })
      return
    }
    if (!project.sourceObjectKey) throw new Error('Media ingestion project or archive not found.')
    assertMediaJobActive(signal)
    const claimed = await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: {
          id: project.id,
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          uploadAttemptId,
          status: { in: ['QUEUED', 'FAILED'] },
        },
        data: { status: 'INVENTORYING', stage: 'inventory', progress: 3, error: null },
      }),
    )
    if (claimed.count !== 1) {
      await updateJobRecord(recordId, { status: 'COMPLETE' })
      return
    }
    assertMediaJobActive(signal)
    workDir = await mkdtemp(join(tmpdir(), `pathfinder-media-${payload.projectId}-`))
    assertMediaJobActive(signal)
    if (!process.env.OPENAI_API_KEY)
      throw new Error('OPENAI_API_KEY is required for media analysis.')
    const settings = project.settings as {
      transcribeAudio?: boolean
      detectDuplicates?: boolean
      videoSecondsPerSample?: number
    }
    const files = assignMediaSourceIds(
      await downloadAndExtract(project.sourceObjectKey, workDir, signal),
    )
    assertMediaJobActive(signal)
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 })
    const analyses: Array<{
      sourceId: string
      filename: string
      mediaType: string
      analysis: Analysis
    }> = []
    const analysesByHash = new Map<string, Analysis>()
    const textRetention = new MediaTextRetentionBudget(MAX_RETAINED_TEXT_CHARACTERS)
    const reserveProviderOperation = () => {
      assertMediaJobActive(signal)
      return reserveMediaProviderOperation({
        tenantId: payload.tenantId,
        projectId: project.id,
        uploadAttemptId,
      })
    }

    assertMediaJobActive(signal)
    await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: {
          id: project.id,
          tenantId: payload.tenantId,
          uploadAttemptId,
        },
        data: {
          status: 'ANALYZING',
          stage: 'analysis',
          progress: 10,
          coverage: { totalFiles: files.length, processedFiles: 0 },
        },
      }),
    )
    assertMediaJobActive(signal)

    for (let index = 0; index < files.length; index++) {
      assertMediaJobActive(signal)
      const file = files[index]!
      const sourceId = file.sourceId
      const mediaType = classify(file.filename)!
      const sha256 = await sha256File(file.path, signal)
      let analysis: Analysis
      try {
        const duplicate =
          settings.detectDuplicates !== false ? analysesByHash.get(sha256) : undefined
        if (duplicate) {
          analysis = duplicate
        } else if (mediaType === 'IMAGE') {
          analysis = await analyzeImage(
            openai,
            reserveProviderOperation,
            generatedOutputBudget,
            file.path,
            sourceId,
            project.context,
            project.mode,
            signal,
          )
        } else if (mediaType === 'AUDIO' && settings.transcribeAudio !== false) {
          analysis = await transcribe(openai, reserveProviderOperation, file.path, signal)
        } else if (mediaType === 'VIDEO') {
          const frameDir = join(workDir, `frames-${index}`)
          analysis = await withMediaGeneratedOutputDirectory(frameDir, async () => {
            const frames = await extractVideoFrames(
              file.path,
              frameDir,
              settings.videoSecondsPerSample ?? 8,
              generatedOutputBudget,
              signal,
            )
            const frameAnalyses: Analysis[] = []
            for (const frame of frames) {
              frameAnalyses.push(
                await analyzeImage(
                  openai,
                  reserveProviderOperation,
                  generatedOutputBudget,
                  join(frameDir, frame),
                  `${sourceId}/${frame}`,
                  project.context,
                  project.mode,
                  signal,
                ),
              )
            }
            let transcript = ''
            if (settings.transcribeAudio !== false) {
              const audioPath = join(frameDir, 'audio.mp3')
              try {
                await extractVideoAudio(file.path, audioPath, generatedOutputBudget, signal)
                transcript = (await transcribe(openai, reserveProviderOperation, audioPath, signal))
                  .summary
              } catch (error) {
                assertMediaJobActive(signal)
                if (error instanceof GlobalAiAdmissionError) throw error
                if (error instanceof UnrecoverableError) throw error
                transcript = ''
              }
            }
            return {
              summary: `Video sampled in ${frames.length} frames.${transcript ? ` Narration transcript: ${transcript}` : ''}`,
              visibleText: frameAnalyses.flatMap((item) => item.visibleText),
              objects: frameAnalyses.flatMap((item) => item.objects),
              spatialClues: frameAnalyses.flatMap((item) => item.spatialClues),
              uncertainties: frameAnalyses.flatMap((item) => item.uncertainties),
            }
          })
        } else if (
          mediaType === 'DOCUMENT' &&
          textExtensions.has(extname(file.filename).toLowerCase())
        ) {
          const allowance = textRetention.allowance(MAX_TEXT_CHARACTERS_PER_FILE)
          if (allowance === 0) {
            analysis = emptyAnalysis(
              'Text file inventoried but not retained.',
              'The media job reached its retained-text safety limit.',
            )
          } else {
            const text = await readUtf8TextPrefix(file.path, allowance, {
              ...(signal ? { signal } : {}),
            })
            textRetention.retain(text)
            analysis = emptyAnalysis(text)
          }
        } else {
          analysis = emptyAnalysis(
            'File inventoried but not analyzed.',
            'This file format needs manual review.',
          )
        }
        assertMediaJobActive(signal)
        analysesByHash.set(sha256, analysis)
        analyses.push({ sourceId, filename: file.filename, mediaType, analysis })
        await persistMediaIngestionAsset({
          tenantId: payload.tenantId,
          projectId: project.id,
          sourceObjectKey: project.sourceObjectKey,
          file,
          mediaType,
          sha256,
          ...(signal ? { signal } : {}),
          outcome: { status: 'COMPLETE', analysis },
        })
      } catch (error) {
        assertMediaJobActive(signal)
        if (error instanceof GlobalAiAdmissionError) throw error
        if (error instanceof UnrecoverableError) throw error
        const message = error instanceof Error ? error.message : 'Unknown asset analysis error'
        analysis = emptyAnalysis('Analysis failed.', message)
        analyses.push({ sourceId, filename: file.filename, mediaType, analysis })
        await persistMediaIngestionAsset({
          tenantId: payload.tenantId,
          projectId: project.id,
          sourceObjectKey: project.sourceObjectKey,
          file,
          mediaType,
          sha256,
          ...(signal ? { signal } : {}),
          outcome: { status: 'FAILED', error: message },
        })
      }
      assertMediaJobActive(signal)
      const progress = 10 + Math.round(((index + 1) / Math.max(files.length, 1)) * 75)
      await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: project.id,
            tenantId: payload.tenantId,
            uploadAttemptId,
          },
          data: { progress, coverage: { totalFiles: files.length, processedFiles: index + 1 } },
        }),
      )
      assertMediaJobActive(signal)
    }

    assertMediaJobActive(signal)
    await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: {
          id: project.id,
          tenantId: payload.tenantId,
          uploadAttemptId,
        },
        data: { status: 'SYNTHESIZING', stage: 'synthesis', progress: 90 },
      }),
    )
    assertMediaJobActive(signal)
    const synthesis = await synthesize(
      openai,
      reserveProviderOperation,
      project.venue.name,
      project.context,
      analyses,
      signal,
    )
    assertMediaJobActive(signal)
    const questions = synthesis.questions
    const draft = mediaSynthesisToVenuePackage(synthesis)
    const failures = analyses.filter((item) => item.analysis.summary === 'Analysis failed.').length
    assertMediaJobActive(signal)
    await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: {
          id: project.id,
          tenantId: payload.tenantId,
          uploadAttemptId,
        },
        data: {
          status: questions.length > 0 ? 'NEEDS_INPUT' : 'READY_FOR_REVIEW',
          stage: questions.length > 0 ? 'questions' : 'review',
          progress: 100,
          questions,
          findings: analyses.map((item) => ({
            sourceId: item.sourceId,
            filename: item.filename,
            mediaType: item.mediaType,
            summary: item.analysis.summary,
            uncertainties: item.analysis.uncertainties,
          })),
          draftJson: draft,
          coverage: {
            totalFiles: files.length,
            processedFiles: files.length,
            failedFiles: failures,
            synthesis: synthesis.coverage,
          },
          completedAt: new Date(),
          uploadAttemptId: null,
        },
      }),
    )
    assertMediaJobActive(signal)
    await updateJobRecord(recordId, { status: 'COMPLETE' })
  } catch (caughtError) {
    if (caughtError instanceof GlobalAiAdmissionError) {
      await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: payload.projectId,
            tenantId: payload.tenantId,
            uploadAttemptId,
            status: { in: ['INVENTORYING', 'ANALYZING', 'SYNTHESIZING'] },
          },
          data: { status: 'QUEUED', stage: 'inventory', progress: 0, error: null },
        }),
      )
      throw caughtError
    }
    const error = normalizeMediaJobError(caughtError, signal)
    const message = error instanceof Error ? error.message : 'Unknown media ingestion error'
    await recordJobFailure({ jobRecordId: recordId, error, errorMessage: message, execution })

    try {
      await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: {
            id: payload.projectId,
            tenantId: payload.tenantId,
            uploadAttemptId,
          },
          data: { status: 'FAILED', error: message },
        }),
      )
    } catch (statusError) {
      logger.warn({
        action: 'media-ingestion.failure-status-persistence-failed',
        projectId: payload.projectId,
        error: statusError instanceof Error ? statusError.message : 'Unknown status update error',
      })
    }
    logger.error({ action: 'media-ingestion.failed', projectId: payload.projectId, error: message })
    throw error
  } finally {
    if (workDir) {
      await cleanupMediaWorkDir(workDir, payload.projectId)
    }
  }
}
