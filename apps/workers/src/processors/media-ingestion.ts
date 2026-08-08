import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import OpenAI from 'openai'
import sharp from 'sharp'
import * as unzipper from 'unzipper'
import ffmpegPath from 'ffmpeg-static'

import { logger } from '@pathfinder/config'
import { db, updateJobRecord, withTenantIsolationBypass, writeJobRecord } from '@pathfinder/db'
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

const MAX_FILES = 10_000
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024 * 1024
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff'])
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm'])
const audioExtensions = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg'])
const textExtensions = new Set(['.txt', '.md', '.csv', '.json'])

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

type Analysis = {
  summary: string
  visibleText: string[]
  objects: Array<{ name: string; confidence: 'confirmed' | 'probable' | 'unverified' }>
  spatialClues: string[]
  uncertainties: string[]
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

function classify(filename: string): 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | null {
  const extension = extname(filename).toLowerCase()
  if (imageExtensions.has(extension)) return 'IMAGE'
  if (videoExtensions.has(extension)) return 'VIDEO'
  if (audioExtensions.has(extension)) return 'AUDIO'
  if (textExtensions.has(extension) || extension === '.pdf') return 'DOCUMENT'
  return null
}

function parseJson(text: string): unknown {
  const unwrapped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  return JSON.parse(unwrapped)
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
  filePath: string,
  sourceId: string,
  context: string,
  mode: string,
): Promise<Analysis> {
  const jpeg = await sharp(filePath)
    .rotate()
    .resize({ width: mode === 'FORENSIC' ? 2200 : 1600, height: 2200, fit: 'inside' })
    .jpeg({ quality: mode === 'ECONOMY' ? 72 : 84 })
    .toBuffer()
  const response = await openai.chat.completions.create({
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
  })
  const text = response.choices[0]?.message.content
  if (!text) throw new Error(`No visual analysis returned for ${sourceId}.`)
  return parseJson(text) as Analysis
}

async function transcribe(openai: OpenAI, filePath: string): Promise<Analysis> {
  const result = await openai.audio.transcriptions.create({
    file: createReadStream(filePath),
    model: process.env.MEDIA_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
  })
  return emptyAnalysis(result.text)
}

async function extractVideoFrames(filePath: string, outputDir: string, interval: number) {
  if (!ffmpegPath) throw new Error('ffmpeg is unavailable in this worker build.')
  const executable = ffmpegPath
  await mkdir(outputDir, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-vf',
        `fps=1/${interval},scale='min(1600,iw)':-2`,
        '-frames:v',
        '120',
        join(outputDir, 'frame-%04d.jpg'),
      ],
      { windowsHide: true },
    )
    let error = ''
    child.stderr.on('data', (chunk: Buffer) => (error += String(chunk)))
    child.once('error', reject)
    child.once('exit', (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(error || `ffmpeg exited ${code}`)),
    )
  })
  return (await readdir(outputDir)).filter((name) => name.endsWith('.jpg')).sort()
}

async function extractVideoAudio(filePath: string, outputPath: string) {
  if (!ffmpegPath) throw new Error('ffmpeg is unavailable in this worker build.')
  const executable = ffmpegPath
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [
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
        outputPath,
      ],
      { windowsHide: true },
    )
    let error = ''
    child.stderr.on('data', (chunk: Buffer) => (error += String(chunk)))
    child.once('error', reject)
    child.once('exit', (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(error || `ffmpeg exited ${code}`)),
    )
  })
}

async function sha256File(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function downloadAndExtract(objectKey: string, destination: string) {
  const bucket = process.env.STORAGE_BUCKET
  if (!bucket) throw new Error('STORAGE_BUCKET is not configured.')
  const response = await storageClient().send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
  )
  if (!response.Body) throw new Error('The uploaded archive is empty.')
  const zip = (response.Body as unknown as Readable).pipe(unzipper.Parse({ forceStream: true }))
  const extracted: Array<{ filename: string; path: string; bytes: number }> = []
  let expandedBytes = 0
  let entriesSeen = 0

  for await (const rawEntry of zip) {
    const entry = rawEntry as unzipper.Entry
    entriesSeen++
    if (entriesSeen > MAX_FILES) throw new Error(`Archive exceeds ${MAX_FILES} entries.`)
    if (entry.type === 'Directory') {
      entry.autodrain()
      continue
    }
    const declaredBytes = Number(
      (entry.vars as typeof entry.vars & { uncompressedSize?: number }).uncompressedSize ?? 0,
    )
    if (declaredBytes > MAX_EXPANDED_BYTES || expandedBytes + declaredBytes > MAX_EXPANDED_BYTES) {
      throw new Error('Archive declares more than the 20 GB expanded-size safety limit.')
    }
    const originalName = entry.path.replace(/\\/g, '/')
    const cleanName = basename(originalName)
    const mediaType = classify(cleanName)
    if (!mediaType || !cleanName || cleanName.startsWith('.')) {
      entry.autodrain()
      continue
    }
    const target = join(
      destination,
      `${String(extracted.length + 1).padStart(5, '0')}-${cleanName}`,
    )
    await pipeline(entry, createWriteStream(target, { flags: 'wx' }))
    const bytes = (await stat(target)).size
    expandedBytes += bytes
    if (expandedBytes > MAX_EXPANDED_BYTES)
      throw new Error('Archive expands beyond the 20 GB safety limit.')
    extracted.push({ filename: originalName, path: target, bytes })
  }
  return extracted
}

async function synthesize(openai: OpenAI, venueName: string, context: string, analyses: unknown[]) {
  let evidence: unknown[] = analyses
  if (JSON.stringify(evidence).length > 250_000) {
    const summaries: unknown[] = []
    for (let index = 0; index < evidence.length; index += 35) {
      const response = await openai.chat.completions.create({
        model:
          process.env.MEDIA_SYNTHESIS_MODEL ?? process.env.MEDIA_ANALYSIS_MODEL ?? 'gpt-5.6-luna',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Condense this evidence batch into JSON while preserving every named object, verbatim label fact, source ID, spatial clue, contradiction, and uncertainty. Merge nothing unless the evidence explicitly establishes a duplicate.',
          },
          { role: 'user', content: JSON.stringify(evidence.slice(index, index + 35)) },
        ],
      })
      const text = response.choices[0]?.message.content
      if (!text) throw new Error('No batch evidence summary was returned.')
      summaries.push(parseJson(text))
    }
    evidence = summaries
  }
  const compact = JSON.stringify(evidence)
  const response = await openai.chat.completions.create({
    model: process.env.MEDIA_SYNTHESIS_MODEL ?? process.env.MEDIA_ANALYSIS_MODEL ?? 'gpt-5.6-luna',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Build draft PathFinder import JSON from evidence summaries. Return schemaVersion 1, places, knowledgeEntries, questions, and coverage. Do not silently resolve conflicts, merge uncertain objects, or treat project context as direct observation. Every place needs title, type, itemType, description, tags, importanceScore, and areaName when known. Put ambiguity that could change the guide in questions.',
      },
      {
        role: 'user',
        content: `Venue: ${venueName}\nOperator context:\n${context.slice(0, 12_000)}\n\nEvidence summaries:\n${compact}`,
      },
    ],
  })
  const text = response.choices[0]?.message.content
  if (!text) throw new Error('No synthesis result was returned.')
  return parseJson(text) as Record<string, unknown>
}

export async function processMediaIngestionJob(
  payload: MediaIngestionJobPayload,
  executionInput?: JobExecutionInput,
) {
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
          venue: { select: { name: true } },
        },
      }),
    )
    if (!project?.sourceObjectKey) throw new Error('Media ingestion project or archive not found.')
    const claimed = await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: {
          id: project.id,
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          status: { in: ['QUEUED', 'FAILED'] },
        },
        data: { status: 'INVENTORYING', stage: 'inventory', progress: 3, error: null },
      }),
    )
    if (claimed.count !== 1) {
      await updateJobRecord(recordId, { status: 'COMPLETE' })
      return
    }
    workDir = await mkdtemp(join(tmpdir(), `pathfinder-media-${payload.projectId}-`))
    if (!process.env.OPENAI_API_KEY)
      throw new Error('OPENAI_API_KEY is required for media analysis.')
    const settings = project.settings as {
      transcribeAudio?: boolean
      detectDuplicates?: boolean
      videoSecondsPerSample?: number
    }
    const files = await downloadAndExtract(project.sourceObjectKey, workDir)
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const analyses: Array<{
      sourceId: string
      filename: string
      mediaType: string
      analysis: Analysis
    }> = []
    const analysesByHash = new Map<string, Analysis>()

    await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: { id: project.id, tenantId: payload.tenantId },
        data: {
          status: 'ANALYZING',
          stage: 'analysis',
          progress: 10,
          coverage: { totalFiles: files.length, processedFiles: 0 },
        },
      }),
    )

    for (let index = 0; index < files.length; index++) {
      const file = files[index]!
      const sourceId =
        basename(file.filename)
          .match(/(?:P|V)\d{3,4}/i)?.[0]
          ?.toUpperCase() ?? `S${String(index + 1).padStart(4, '0')}`
      const mediaType = classify(file.filename)!
      const sha256 = await sha256File(file.path)
      let analysis: Analysis
      try {
        const duplicate =
          settings.detectDuplicates !== false ? analysesByHash.get(sha256) : undefined
        if (duplicate) {
          analysis = duplicate
        } else if (mediaType === 'IMAGE') {
          analysis = await analyzeImage(openai, file.path, sourceId, project.context, project.mode)
        } else if (mediaType === 'AUDIO' && settings.transcribeAudio !== false) {
          analysis = await transcribe(openai, file.path)
        } else if (mediaType === 'VIDEO') {
          const frameDir = join(workDir, `frames-${index}`)
          const frames = await extractVideoFrames(
            file.path,
            frameDir,
            settings.videoSecondsPerSample ?? 8,
          )
          const frameAnalyses: Analysis[] = []
          for (const frame of frames) {
            frameAnalyses.push(
              await analyzeImage(
                openai,
                join(frameDir, frame),
                `${sourceId}/${frame}`,
                project.context,
                project.mode,
              ),
            )
          }
          let transcript = ''
          if (settings.transcribeAudio !== false) {
            const audioPath = join(frameDir, 'audio.mp3')
            try {
              await extractVideoAudio(file.path, audioPath)
              transcript = (await transcribe(openai, audioPath)).summary
            } catch {
              transcript = ''
            }
          }
          analysis = {
            summary: `Video sampled in ${frames.length} frames.${transcript ? ` Narration transcript: ${transcript}` : ''}`,
            visibleText: frameAnalyses.flatMap((item) => item.visibleText),
            objects: frameAnalyses.flatMap((item) => item.objects),
            spatialClues: frameAnalyses.flatMap((item) => item.spatialClues),
            uncertainties: frameAnalyses.flatMap((item) => item.uncertainties),
          }
        } else if (
          mediaType === 'DOCUMENT' &&
          textExtensions.has(extname(file.filename).toLowerCase())
        ) {
          analysis = emptyAnalysis((await readFile(file.path, 'utf8')).slice(0, 100_000))
        } else {
          analysis = emptyAnalysis(
            'File inventoried but not analyzed.',
            'This file format needs manual review.',
          )
        }
        analysesByHash.set(sha256, analysis)
        analyses.push({ sourceId, filename: file.filename, mediaType, analysis })
        await withTenantIsolationBypass(() =>
          db.mediaIngestionAsset.upsert({
            where: { projectId_sourceId: { projectId: project.id, sourceId } },
            create: {
              tenantId: payload.tenantId,
              projectId: project.id,
              sourceId,
              filename: file.filename,
              mediaType,
              objectKey: `${project.sourceObjectKey}#${file.filename}`,
              bytes: BigInt(file.bytes),
              sha256,
              status: 'COMPLETE',
              analysis,
            },
            update: { status: 'COMPLETE', analysis, sha256, error: null },
          }),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown asset analysis error'
        analysis = emptyAnalysis('Analysis failed.', message)
        analyses.push({ sourceId, filename: file.filename, mediaType, analysis })
        await withTenantIsolationBypass(() =>
          db.mediaIngestionAsset.upsert({
            where: { projectId_sourceId: { projectId: project.id, sourceId } },
            create: {
              tenantId: payload.tenantId,
              projectId: project.id,
              sourceId,
              filename: file.filename,
              mediaType,
              objectKey: `${project.sourceObjectKey}#${file.filename}`,
              bytes: BigInt(file.bytes),
              sha256,
              status: 'FAILED',
              error: message,
            },
            update: { status: 'FAILED', error: message },
          }),
        )
      }
      const progress = 10 + Math.round(((index + 1) / Math.max(files.length, 1)) * 75)
      await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: { id: project.id, tenantId: payload.tenantId },
          data: { progress, coverage: { totalFiles: files.length, processedFiles: index + 1 } },
        }),
      )
    }

    await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: { id: project.id, tenantId: payload.tenantId },
        data: { status: 'SYNTHESIZING', stage: 'synthesis', progress: 90 },
      }),
    )
    const draft = await synthesize(openai, project.venue.name, project.context, analyses)
    const questions = Array.isArray(draft.questions) ? draft.questions : []
    const failures = analyses.filter((item) => item.analysis.summary === 'Analysis failed.').length
    await withTenantIsolationBypass(() =>
      db.mediaIngestionProject.updateMany({
        where: { id: project.id, tenantId: payload.tenantId },
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
          },
          completedAt: new Date(),
        },
      }),
    )
    await updateJobRecord(recordId, { status: 'COMPLETE' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown media ingestion error'
    await recordJobFailure({ jobRecordId: recordId, error, errorMessage: message, execution })

    try {
      await withTenantIsolationBypass(() =>
        db.mediaIngestionProject.updateMany({
          where: { id: payload.projectId, tenantId: payload.tenantId },
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
