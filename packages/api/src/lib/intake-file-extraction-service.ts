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
export const INTAKE_PDF_EXTRACTION_MAX_BYTES = 10 * 1024 * 1024
export const INTAKE_PDF_EXTRACTION_MAX_PAGES = 200
export const INTAKE_PDF_EXTRACTION_TIMEOUT_MS = 15_000
export const INTAKE_PDF_EXTRACTOR = 'pathfinder-pdfjs-document'
export const INTAKE_PDF_EXTRACTOR_VERSION = '1'
export const INTAKE_TEXT_MIME_TYPES = [
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const

type SupportedTextMime = (typeof INTAKE_TEXT_MIME_TYPES)[number]
type SupportedDocumentMime = SupportedTextMime | 'application/pdf'

type FileExtractionFailureCode =
  | 'UNSAFE_TEXT_CONTROL'
  | 'TEXT_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'EMPTY_TEXT'
  | 'PDF_TOO_MANY_PAGES'
  | 'PDF_NO_EXTRACTABLE_TEXT'
  | 'PDF_EXTRACTION_TIMEOUT'
  | 'PDF_PASSWORD_REQUIRED'
  | 'PDF_PARSE_FAILED'

type ExtractionResult =
  | {
      outcome: 'SUCCEEDED'
      text: string
      textHash: string
      characterCount: number
      lineCount: number
    }
  | { outcome: 'FAILED'; errorCode: FileExtractionFailureCode }

type ExtractionProfile = {
  domain: string
  extractor: typeof INTAKE_TEXT_EXTRACTOR | typeof INTAKE_PDF_EXTRACTOR
  extractorVersion: '1'
  maxBytes: number
  maxCharacters: number
  maxPages?: number
  timeoutMs?: number
}

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

function isSupportedDocumentMime(value: string): value is SupportedDocumentMime {
  return value === 'application/pdf' || isSupportedTextMime(value)
}

function extractionProfile(mimeType: SupportedDocumentMime): ExtractionProfile {
  return mimeType === 'application/pdf'
    ? {
        domain: 'pathfinder.intake-file-pdf-extraction.v1',
        extractor: INTAKE_PDF_EXTRACTOR,
        extractorVersion: INTAKE_PDF_EXTRACTOR_VERSION,
        maxBytes: INTAKE_PDF_EXTRACTION_MAX_BYTES,
        maxCharacters: INTAKE_TEXT_EXTRACTION_MAX_CHARACTERS,
        maxPages: INTAKE_PDF_EXTRACTION_MAX_PAGES,
        timeoutMs: INTAKE_PDF_EXTRACTION_TIMEOUT_MS,
      }
    : {
        domain: 'pathfinder.intake-file-extraction.v1',
        extractor: INTAKE_TEXT_EXTRACTOR,
        extractorVersion: INTAKE_TEXT_EXTRACTOR_VERSION,
        maxBytes: INTAKE_TEXT_EXTRACTION_MAX_BYTES,
        maxCharacters: INTAKE_TEXT_EXTRACTION_MAX_CHARACTERS,
      }
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
  profile: ExtractionProfile
}) {
  const { profile, ...identity } = input
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain: profile.domain,
        extractor: profile.extractor,
        extractorVersion: profile.extractorVersion,
        maxBytes: profile.maxBytes,
        maxCharacters: profile.maxCharacters,
        ...(profile.maxPages === undefined ? {} : { maxPages: profile.maxPages }),
        ...(profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs }),
        ...identity,
      }),
    )
    .digest('hex')
}

async function readBoundedBytes(input: {
  key: string
  versionId: string
  expectedBytes: number
  maxBytes: number
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
      if (byteSize > input.expectedBytes || byteSize > input.maxBytes) {
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

function normalizeExtractedText(
  value: string,
  emptyFailure: { errorCode: FileExtractionFailureCode },
): ExtractionResult {
  const text = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  if (!text.trim()) return { outcome: 'FAILED', ...emptyFailure }
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) {
      return {
        outcome: 'FAILED',
        errorCode: 'UNSAFE_TEXT_CONTROL',
      }
    }
  }
  const characterCount = [...text].length
  if (characterCount > INTAKE_TEXT_EXTRACTION_MAX_CHARACTERS) {
    return {
      outcome: 'FAILED',
      errorCode: 'TEXT_TOO_LARGE',
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

function normalizeText(bytes: Uint8Array): ExtractionResult {
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      outcome: 'FAILED',
      errorCode: 'INVALID_UTF8',
    }
  }
  return normalizeExtractedText(decoded, {
    errorCode: 'EMPTY_TEXT',
  })
}

function appendPdfTextItem(line: string, value: string) {
  if (!value) return line
  if (!line || /\s$/u.test(line) || /^[,.;:!?)}\]]/u.test(value)) return `${line}${value}`
  return `${line} ${value}`
}

async function extractPdfText(bytes: Uint8Array): Promise<ExtractionResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    stopAtErrors: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    void loadingTask.destroy()
  }, INTAKE_PDF_EXTRACTION_TIMEOUT_MS)
  try {
    const document = await loadingTask.promise
    if (document.numPages > INTAKE_PDF_EXTRACTION_MAX_PAGES) {
      return {
        outcome: 'FAILED',
        errorCode: 'PDF_TOO_MANY_PAGES',
      }
    }
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const lines: string[] = []
        let line = ''
        for (const item of content.items) {
          if (!('str' in item)) continue
          line = appendPdfTextItem(line, item.str)
          if (item.hasEOL) {
            lines.push(line.trimEnd())
            line = ''
          }
        }
        if (line) lines.push(line.trimEnd())
        pages.push(lines.join('\n').trim())
      } finally {
        page.cleanup()
      }
    }
    return normalizeExtractedText(pages.filter(Boolean).join('\n\n'), {
      errorCode: 'PDF_NO_EXTRACTABLE_TEXT',
    })
  } catch (error) {
    return {
      outcome: 'FAILED',
      errorCode: timedOut
        ? 'PDF_EXTRACTION_TIMEOUT'
        : error instanceof Error && error.name === 'PasswordException'
          ? 'PDF_PASSWORD_REQUIRED'
          : 'PDF_PARSE_FAILED',
    }
  } finally {
    clearTimeout(timeout)
    if (!timedOut) await loadingTask.destroy()
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
  if (!isSupportedDocumentMime(upload.mimeType)) {
    throw new IntakeFileExtractionError(
      'UNSUPPORTED_SOURCE',
      'This source needs a different document, media, or OCR extraction adapter.',
    )
  }
  const profile = extractionProfile(upload.mimeType)
  if (upload.byteSize > profile.maxBytes) {
    throw new IntakeFileExtractionError(
      'SOURCE_TOO_LARGE',
      upload.mimeType === 'application/pdf'
        ? 'This PDF exceeds the 10 MB deterministic extraction boundary.'
        : 'This text-like document exceeds the 2 MB deterministic extraction boundary.',
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
    maxBytes: profile.maxBytes,
    ...(input.storage ? { storage: input.storage } : {}),
  })
  if (read.byteSize !== upload.byteSize || read.sha256 !== upload.sha256) {
    throw new IntakeFileExtractionError(
      'CONFLICT',
      'The exact stored file no longer matches its verified size and hash.',
    )
  }
  const extraction =
    upload.mimeType === 'application/pdf'
      ? await extractPdfText(read.bytes)
      : normalizeText(read.bytes)
  try {
    return await recordIntakeFileExtractionReceiptAction({
      operationId: input.operationId,
      ...identity,
      requestHash: requestHash({ ...identity, profile }),
      outcome: extraction.outcome,
      extractor: profile.extractor,
      extractorVersion: profile.extractorVersion,
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
