import { createHmac, createHash, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import type { TRPCContext } from '../context'

export const INTAKE_FILE_EXTRACTION_READER_DEFAULT_PAGE_SIZE = 2_000
export const INTAKE_FILE_EXTRACTION_READER_MAX_PAGE_SIZE = 4_000

const readerInput = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    runId: z.string().trim().min(1).max(191),
    receiptId: z.string().uuid(),
    expectedExtractedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    cursor: z.string().min(1).max(1_024).optional(),
    pageSize: z.number().int().min(1).max(INTAKE_FILE_EXTRACTION_READER_MAX_PAGE_SIZE).optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

type ReaderInput = z.infer<typeof readerInput>

type ReaderClient = Pick<TRPCContext['db'], 'intakeFileExtractionReceipt'>

export class IntakeFileExtractionReaderError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeFileExtractionReaderError'
  }
}

type CursorPayload = Readonly<{
  v: 2
  unit: 'codePoint'
  offset: number
  searchHash: string
  signature: string
}>

function searchHash(search: string | undefined) {
  return createHash('sha256')
    .update(search ?? '')
    .digest('hex')
}

function cursorSignature(
  requestHash: string,
  receiptId: string,
  extractedTextHash: string,
  offset: number,
  requestedSearchHash: string,
) {
  return createHmac('sha256', requestHash)
    .update(`2:codePoint:${receiptId}:${extractedTextHash}:${offset}:${requestedSearchHash}`)
    .digest('base64url')
}

function encodeCursor(payload: CursorPayload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    const result = z
      .object({
        v: z.literal(2),
        unit: z.literal('codePoint'),
        offset: z.number().int().min(0),
        searchHash: z.string().regex(/^[a-f0-9]{64}$/u),
        signature: z.string().min(1).max(128),
      })
      .strict()
      .safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function buildCaseFoldedSearchIndex(codePoints: readonly string[]) {
  const foldedCodeUnitToSourceCodePoint: number[] = []
  const sourceCodePointToFoldedCodeUnit: number[] = []
  for (const [sourceIndex, codePoint] of codePoints.entries()) {
    sourceCodePointToFoldedCodeUnit.push(foldedCodeUnitToSourceCodePoint.length)
    const folded = codePoint.toLowerCase()
    for (let index = 0; index < folded.length; index += 1) {
      foldedCodeUnitToSourceCodePoint.push(sourceIndex)
    }
  }
  sourceCodePointToFoldedCodeUnit.push(foldedCodeUnitToSourceCodePoint.length)
  return {
    text: codePoints.join('').toLowerCase(),
    foldedCodeUnitAt(sourceCodePoint: number) {
      return sourceCodePointToFoldedCodeUnit[sourceCodePoint]
    },
    sourceCodePointAt(foldedCodeUnit: number) {
      return foldedCodeUnitToSourceCodePoint[foldedCodeUnit]
    },
  }
}

function findSearchMatchOffsets(
  source: ReturnType<typeof buildCaseFoldedSearchIndex>,
  search: string | undefined,
  start: number,
  end: number,
  limit: number,
) {
  if (!search) return []
  const needle = search.toLowerCase()
  const offsets: number[] = []
  let match = source.text.indexOf(needle, source.foldedCodeUnitAt(start))
  while (match !== -1 && offsets.length < limit) {
    const sourceOffset = source.sourceCodePointAt(match)
    if (sourceOffset === undefined || sourceOffset >= end) break
    if (sourceOffset !== undefined && offsets.at(-1) !== sourceOffset) offsets.push(sourceOffset)
    match = source.text.indexOf(needle, match + Math.max(needle.length, 1))
  }
  return offsets
}

function isValidCursorSignature(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

/**
 * Reads only retained extraction text. Original upload bytes and storage URLs intentionally remain
 * outside this review surface.
 */
export async function readIntakeFileExtractionSource(rawInput: ReaderInput, client: ReaderClient) {
  const parsed = readerInput.safeParse(rawInput)
  if (!parsed.success) {
    throw new IntakeFileExtractionReaderError('INVALID_INPUT', 'Invalid source-reader request.')
  }
  const input = parsed.data
  const receipt = await client.intakeFileExtractionReceipt.findFirst({
    where: {
      id: input.receiptId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      runId: input.runId,
      outcome: 'SUCCEEDED',
      extractedTextHash: input.expectedExtractedTextHash,
      run: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
    },
    select: {
      requestHash: true,
      extractedText: true,
      extractedTextHash: true,
      extractedCharacterCount: true,
      extractedLineCount: true,
      sourceSha256: true,
      sourceMimeType: true,
      sourceObjectGeneration: true,
      sourceStorageVersionId: true,
      upload: {
        select: {
          objectGeneration: true,
          storageVersionId: true,
          sha256: true,
          mimeType: true,
          status: true,
        },
      },
    },
  })
  if (
    !receipt?.extractedText ||
    !receipt.extractedTextHash ||
    receipt.extractedTextHash !== input.expectedExtractedTextHash
  ) {
    throw new IntakeFileExtractionReaderError(
      'NOT_FOUND',
      'Successful exact file extraction not found.',
    )
  }
  const freshSource =
    receipt.upload.objectGeneration === receipt.sourceObjectGeneration &&
    receipt.upload.storageVersionId === receipt.sourceStorageVersionId &&
    receipt.upload.sha256 === receipt.sourceSha256 &&
    receipt.upload.mimeType === receipt.sourceMimeType &&
    receipt.upload.status === 'AWAITING_REVIEW'
  if (!freshSource) {
    throw new IntakeFileExtractionReaderError(
      'CONFLICT',
      'The file source changed after extraction; request a fresh extraction receipt.',
    )
  }

  const requestedSearchHash = searchHash(input.search)
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined
  if (
    cursor &&
    (!isValidCursorSignature(
      cursor.signature,
      cursorSignature(
        receipt.requestHash,
        input.receiptId,
        receipt.extractedTextHash,
        cursor.offset,
        requestedSearchHash,
      ),
    ) ||
      cursor.searchHash !== requestedSearchHash)
  ) {
    throw new IntakeFileExtractionReaderError(
      'CONFLICT',
      'The source-reader continuation is invalid.',
    )
  }
  if (input.cursor && !cursor) {
    throw new IntakeFileExtractionReaderError(
      'CONFLICT',
      'The source-reader continuation is invalid.',
    )
  }

  const pageSize = input.pageSize ?? INTAKE_FILE_EXTRACTION_READER_DEFAULT_PAGE_SIZE
  const codePoints = Array.from(receipt.extractedText)
  const searchIndex = input.search ? buildCaseFoldedSearchIndex(codePoints) : null
  const firstSearchMatch = searchIndex
    ? (findSearchMatchOffsets(searchIndex, input.search, 0, codePoints.length, 1)[0] ?? -1)
    : -1
  const offset =
    cursor?.offset ??
    (firstSearchMatch < 0 ? 0 : Math.max(0, firstSearchMatch - Math.floor(pageSize / 4)))
  if (offset > codePoints.length) {
    throw new IntakeFileExtractionReaderError(
      'CONFLICT',
      'The source-reader continuation is invalid.',
    )
  }
  const pageEnd = Math.min(offset + pageSize, codePoints.length)
  const nextOffset = pageEnd < codePoints.length ? pageEnd : null
  const nextCursor =
    nextOffset === null
      ? null
      : encodeCursor({
          v: 2,
          unit: 'codePoint',
          offset: nextOffset,
          searchHash: requestedSearchHash,
          signature: cursorSignature(
            receipt.requestHash,
            input.receiptId,
            receipt.extractedTextHash,
            nextOffset,
            requestedSearchHash,
          ),
        })
  const pageText = codePoints.slice(offset, pageEnd).join('')
  const matchOffsets = searchIndex
    ? findSearchMatchOffsets(searchIndex, input.search, offset, pageEnd, 100).map(
        (match) => match - offset,
      )
    : []

  return {
    receiptId: input.receiptId,
    extractedTextHash: receipt.extractedTextHash,
    source: {
      sha256: receipt.sourceSha256,
      mimeType: receipt.sourceMimeType,
    },
    extractedCharacterCount: receipt.extractedCharacterCount,
    extractedLineCount: receipt.extractedLineCount,
    page: { offset, limit: pageSize, text: pageText, matchOffsets },
    nextCursor,
  }
}
