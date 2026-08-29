import { createHash } from 'node:crypto'

import {
  IntakeFileExtractionActionError,
  recordIntakeFileExtractionReceiptAction,
} from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { readIntakeUploadVersion, type IntakeUploadStorageTransport } from './intake-upload-storage'

export const INTAKE_TEXT_EXTRACTION_MAX_BYTES = 2 * 1024 * 1024
export const INTAKE_TEXT_EXTRACTION_MAX_CHARACTERS = 500_000
export const INTAKE_TEXT_EXTRACTOR = 'pathfinder-utf8-document'
export const INTAKE_TEXT_EXTRACTOR_VERSION = '1'
export const INTAKE_TEXT_MIME_TYPES = [
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const

type SupportedTextMime = (typeof INTAKE_TEXT_MIME_TYPES)[number]

export class IntakeFileExtractionError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'UNSUPPORTED_SOURCE'
      | 'SOURCE_TOO_LARGE'
      | 'SOURCE_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeFileExtractionError'
  }
}

function isSupportedTextMime(value: string): value is SupportedTextMime {
  return (INTAKE_TEXT_MIME_TYPES as readonly string[]).includes(value)
}

function requestHash(input: {
  tenantId: string
  venueId: string
  runId: string
  uploadId: string
  sourceObjectGeneration: string
  sourceStorageVersionId: string
  sourceSha256: string
  sourceByteSize: number
  sourceMimeType: string
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'pathfinder.intake-file-extraction.v1',
        extractor: INTAKE_TEXT_EXTRACTOR,
        extractorVersion: INTAKE_TEXT_EXTRACTOR_VERSION,
        maxBytes: INTAKE_TEXT_EXTRACTION_MAX_BYTES,
        maxCharacters: INTAKE_TEXT_EXTRACTION_MAX_CHARACTERS,
        ...input,
      }),
    )
    .digest('hex')
}

async function readBoundedBytes(input: {
  key: string
  versionId: string
  expectedBytes: number
  storage?: IntakeUploadStorageTransport
}) {
  let source: AsyncIterable<Uint8Array>
  try {
    source = await readIntakeUploadVersion({
      key: input.key,
      versionId: input.versionId,
      ...(input.storage ? { storage: input.storage } : {}),
    })
  } catch {
    throw new IntakeFileExtractionError(
      'SOURCE_UNAVAILABLE',
      'The exact verified file version is temporarily unavailable.',
    )
  }
  const chunks: Buffer[] = []
  let byteSize = 0
  const digest = createHash('sha256')
  try {
    for await (const chunk of source) {
      byteSize += chunk.byteLength
      if (byteSize > input.expectedBytes || byteSize > INTAKE_TEXT_EXTRACTION_MAX_BYTES) {
        throw new IntakeFileExtractionError(
          'CONFLICT',
          'The exact stored file exceeded its verified extraction boundary.',
        )
      }
      digest.update(chunk)
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    if (error instanceof IntakeFileExtractionError) throw error
    throw new IntakeFileExtractionError(
      'SOURCE_UNAVAILABLE',
      'The exact verified file version could not be read completely.',
    )
  }
  return { bytes: Buffer.concat(chunks), byteSize, sha256: digest.digest('hex') }
}

function normalizeText(bytes: Uint8Array):
  | {
      outcome: 'SUCCEEDED'
      text: string
      textHash: string
      characterCount: number
      lineCount: number
    }
  | { outcome: 'FAILED'; errorCode: string; errorMessage: string } {
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      outcome: 'FAILED',
      errorCode: 'INVALID_UTF8',
      errorMessage: 'The verified document is not valid UTF-8 text.',
    }
  }
  const text = decoded.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  if (!text.trim()) {
    return {
      outcome: 'FAILED',
      errorCode: 'EMPTY_TEXT',
      errorMessage: 'The verified document contains no reviewable text.',
    }
  }
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) {
      return {
        outcome: 'FAILED',
        errorCode: 'UNSAFE_TEXT_CONTROL',
        errorMessage: 'The verified document contains unsupported control characters.',
      }
    }
  }
  const characterCount = [...text].length
  if (characterCount > INTAKE_TEXT_EXTRACTION_MAX_CHARACTERS) {
    return {
      outcome: 'FAILED',
      errorCode: 'TEXT_TOO_LARGE',
      errorMessage: 'The verified document exceeds the bounded review-text limit.',
    }
  }
  return {
    outcome: 'SUCCEEDED',
    text,
    textHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    characterCount,
    lineCount: text.split('\n').length,
  }
}

export async function executeIntakeFileExtraction(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
  operationId: string
  createdBy: string
  storage?: IntakeUploadStorageTransport
}) {
  const run = await input.db.intakeRun.findFirst({
    where: {
      id: input.runId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceKind: 'FILE_UPLOAD',
      status: 'AWAITING_REVIEW',
    },
    select: {
      upload: {
        select: {
          id: true,
          status: true,
          objectKey: true,
          objectGeneration: true,
          storageVersionId: true,
          sha256: true,
          byteSize: true,
          mimeType: true,
        },
      },
    },
  })
  if (!run?.upload) {
    throw new IntakeFileExtractionError('NOT_FOUND', 'Verified file intake source not found.')
  }
  const upload = run.upload
  if (upload.status !== 'AWAITING_REVIEW' || !upload.storageVersionId) {
    throw new IntakeFileExtractionError(
      'CONFLICT',
      'The file must finish exact verification before extraction.',
    )
  }
  if (!isSupportedTextMime(upload.mimeType)) {
    throw new IntakeFileExtractionError(
      'UNSUPPORTED_SOURCE',
      'This source needs a different document, media, or OCR extraction adapter.',
    )
  }
  if (upload.byteSize > INTAKE_TEXT_EXTRACTION_MAX_BYTES) {
    throw new IntakeFileExtractionError(
      'SOURCE_TOO_LARGE',
      'This text-like document exceeds the 2 MB deterministic extraction boundary.',
    )
  }
  const identity = {
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
    uploadId: upload.id,
    sourceObjectGeneration: upload.objectGeneration,
    sourceStorageVersionId: upload.storageVersionId,
    sourceSha256: upload.sha256,
    sourceByteSize: upload.byteSize,
    sourceMimeType: upload.mimeType,
  }
  const read = await readBoundedBytes({
    key: upload.objectKey,
    versionId: upload.storageVersionId,
    expectedBytes: upload.byteSize,
    ...(input.storage ? { storage: input.storage } : {}),
  })
  if (read.byteSize !== upload.byteSize || read.sha256 !== upload.sha256) {
    throw new IntakeFileExtractionError(
      'CONFLICT',
      'The exact stored file no longer matches its verified size and hash.',
    )
  }
  const extraction = normalizeText(read.bytes)
  try {
    return await recordIntakeFileExtractionReceiptAction({
      operationId: input.operationId,
      ...identity,
      requestHash: requestHash(identity),
      outcome: extraction.outcome,
      extractor: INTAKE_TEXT_EXTRACTOR,
      extractorVersion: INTAKE_TEXT_EXTRACTOR_VERSION,
      ...(extraction.outcome === 'SUCCEEDED'
        ? {
            extractedText: extraction.text,
            extractedTextHash: extraction.textHash,
            extractedCharacterCount: extraction.characterCount,
            extractedLineCount: extraction.lineCount,
          }
        : {
            extractedCharacterCount: 0,
            extractedLineCount: 0,
            errorCode: extraction.errorCode,
            errorMessage: extraction.errorMessage,
          }),
      createdBy: input.createdBy,
    })
  } catch (error) {
    if (error instanceof IntakeFileExtractionActionError) {
      throw new IntakeFileExtractionError(
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'CONFLICT',
        error.message,
      )
    }
    throw error
  }
}
