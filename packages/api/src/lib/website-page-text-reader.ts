import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { WebsitePageTextEvidenceCollection } from '@pathfinder/contracts'
import { z } from 'zod'

import type { TRPCContext } from '../context'

export const WEBSITE_PAGE_TEXT_READER_DEFAULT_PAGE_SIZE = 2_000
export const WEBSITE_PAGE_TEXT_READER_MAX_PAGE_SIZE = 4_000

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const inputSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    runId: z.string().trim().min(1).max(191),
    receiptId: z.string().uuid(),
    sourceUrl: z.string().url().max(2_048),
    expectedExactByteHash: hash,
    expectedRetainedTextHash: hash,
    cursor: z.string().min(1).max(1_024).optional(),
    pageSize: z.number().int().min(1).max(WEBSITE_PAGE_TEXT_READER_MAX_PAGE_SIZE).optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

type ReaderInput = z.infer<typeof inputSchema>
type ReaderClient = Pick<TRPCContext['db'], 'intakeWebsiteResearchReceipt'>

const listInputSchema = inputSchema.pick({
  tenantId: true,
  venueId: true,
  runId: true,
  receiptId: true,
})

export class WebsitePageTextReaderError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'WebsitePageTextReaderError'
  }
}

const researchSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceId: z.string().trim().min(1).max(191),
    pages: z
      .array(
        z
          .object({
            url: z.string(),
            normalizedHash: hash,
          })
          .passthrough(),
      )
      .max(100),
    pageTextEvidence: WebsitePageTextEvidenceCollection.optional(),
  })
  .passthrough()

export async function listWebsitePageText(
  rawInput: z.infer<typeof listInputSchema>,
  client: ReaderClient,
) {
  const parsed = listInputSchema.safeParse(rawInput)
  if (!parsed.success)
    throw new WebsitePageTextReaderError('INVALID_INPUT', 'Invalid page-text listing request.')
  const input = parsed.data
  const receipt = await client.intakeWebsiteResearchReceipt.findFirst({
    where: {
      id: input.receiptId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      runId: input.runId,
      outcome: 'SUCCEEDED',
    },
    select: { researchSnapshot: true },
  })
  if (!receipt)
    throw new WebsitePageTextReaderError(
      'NOT_FOUND',
      'Successful exact website research receipt not found.',
    )
  const research = researchSchema.safeParse(receipt.researchSnapshot)
  if (!research.success)
    throw new WebsitePageTextReaderError('CONFLICT', 'Stored website research evidence is invalid.')
  if (research.data.sourceId !== input.runId)
    throw new WebsitePageTextReaderError(
      'CONFLICT',
      'Stored website research evidence does not match its run.',
    )
  if (!research.data.pageTextEvidence)
    return {
      status: 'NOT_RECORDED' as const,
      receiptId: input.receiptId,
      sourceId: research.data.sourceId,
      pages: [],
    }
  const fetchedByUrl = new Map(research.data.pages.map((page) => [page.url, page.normalizedHash]))
  for (const evidence of research.data.pageTextEvidence) {
    if (
      fetchedByUrl.get(evidence.sourceUrl) !== evidence.exactByteHash ||
      sha256(evidence.text) !== evidence.retainedTextHash
    ) {
      throw new WebsitePageTextReaderError(
        'CONFLICT',
        'Website page text evidence no longer matches its provenance.',
      )
    }
  }
  return {
    status: 'RECORDED' as const,
    receiptId: input.receiptId,
    sourceId: research.data.sourceId,
    pages: research.data.pageTextEvidence.map((page) => ({
      sourceUrl: page.sourceUrl,
      exactByteHash: page.exactByteHash,
      capturedAt: page.capturedAt,
      extractionProfile: page.extractionProfile,
      normalizedTextHash: page.normalizedTextHash,
      retainedTextHash: page.retainedTextHash,
      fullCodePointCount: page.fullCodePointCount,
      retainedCodePointCount: page.retainedCodePointCount,
      truncated: page.truncated,
    })),
  }
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    unit: z.literal('codePoint'),
    offset: z.number().int().min(0),
    searchHash: hash,
    signature: z.string().min(1).max(128),
  })
  .strict()

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function signature(input: ReaderInput, requestHash: string, offset: number, searchHash: string) {
  return createHmac('sha256', requestHash)
    .update(
      JSON.stringify({
        v: 1,
        unit: 'codePoint',
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        receiptId: input.receiptId,
        sourceUrl: input.sourceUrl,
        exactByteHash: input.expectedExactByteHash,
        retainedTextHash: input.expectedRetainedTextHash,
        pageSize: input.pageSize ?? WEBSITE_PAGE_TEXT_READER_DEFAULT_PAGE_SIZE,
        offset,
        searchHash,
      }),
    )
    .digest('base64url')
}

function decodeCursor(value: string) {
  try {
    return cursorSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch {
    return { success: false as const }
  }
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Reads retained, static page prose only; it performs no fetch, mapping, review, or mutation. */
export async function readWebsitePageText(rawInput: ReaderInput, client: ReaderClient) {
  const parsedInput = inputSchema.safeParse(rawInput)
  if (!parsedInput.success)
    throw new WebsitePageTextReaderError('INVALID_INPUT', 'Invalid page-text reader request.')
  const input = parsedInput.data
  const receipt = await client.intakeWebsiteResearchReceipt.findFirst({
    where: {
      id: input.receiptId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      runId: input.runId,
      outcome: 'SUCCEEDED',
    },
    select: { requestHash: true, researchSnapshot: true },
  })
  if (!receipt)
    throw new WebsitePageTextReaderError(
      'NOT_FOUND',
      'Successful exact website research receipt not found.',
    )

  const research = researchSchema.safeParse(receipt.researchSnapshot)
  if (!research.success)
    throw new WebsitePageTextReaderError('CONFLICT', 'Stored website research evidence is invalid.')
  if (research.data.sourceId !== input.runId)
    throw new WebsitePageTextReaderError(
      'CONFLICT',
      'Stored website research evidence does not match its run.',
    )
  if (!research.data.pageTextEvidence) {
    return {
      status: 'NOT_RECORDED' as const,
      receiptId: input.receiptId,
      sourceUrl: input.sourceUrl,
    }
  }
  const evidence = research.data.pageTextEvidence.find((item) => item.sourceUrl === input.sourceUrl)
  const provenance = research.data.pages.find((item) => item.url === input.sourceUrl)
  if (!evidence || !provenance)
    throw new WebsitePageTextReaderError('NOT_FOUND', 'Exact website page text evidence not found.')
  if (
    evidence.exactByteHash !== provenance.normalizedHash ||
    evidence.exactByteHash !== input.expectedExactByteHash ||
    evidence.retainedTextHash !== input.expectedRetainedTextHash ||
    sha256(evidence.text) !== evidence.retainedTextHash
  ) {
    throw new WebsitePageTextReaderError(
      'CONFLICT',
      'Website page text evidence no longer matches its provenance.',
    )
  }

  const requestedSearchHash = sha256(input.search ?? '')
  let offset = 0
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor)
    if (
      !decoded.success ||
      decoded.data.searchHash !== requestedSearchHash ||
      !constantTimeEqual(
        decoded.data.signature,
        signature(input, receipt.requestHash, decoded.data.offset, requestedSearchHash),
      )
    ) {
      throw new WebsitePageTextReaderError(
        'CONFLICT',
        'The page-text reader continuation is invalid.',
      )
    }
    offset = decoded.data.offset
  }
  const codePoints = [...evidence.text]
  const pageSize = input.pageSize ?? WEBSITE_PAGE_TEXT_READER_DEFAULT_PAGE_SIZE
  if (!input.cursor && input.search) {
    const found = evidence.text.indexOf(input.search)
    if (found >= 0)
      offset = Math.max(0, [...evidence.text.slice(0, found)].length - Math.floor(pageSize / 4))
  }
  if (offset > codePoints.length)
    throw new WebsitePageTextReaderError(
      'CONFLICT',
      'The page-text reader continuation is invalid.',
    )
  const end = Math.min(offset + pageSize, codePoints.length)
  const text = codePoints.slice(offset, end).join('')
  const matchOffsets: number[] = []
  if (input.search) {
    const haystack = text
    const needle = input.search
    let at = haystack.indexOf(needle)
    while (at >= 0 && matchOffsets.length < 100) {
      matchOffsets.push([...text.slice(0, at)].length)
      at = haystack.indexOf(needle, at + Math.max(needle.length, 1))
    }
  }
  const nextOffset = end < codePoints.length ? end : null
  const nextCursor =
    nextOffset === null
      ? null
      : Buffer.from(
          JSON.stringify({
            v: 1,
            unit: 'codePoint',
            offset: nextOffset,
            searchHash: requestedSearchHash,
            signature: signature(input, receipt.requestHash, nextOffset, requestedSearchHash),
          }),
          'utf8',
        ).toString('base64url')

  return {
    status: 'RECORDED' as const,
    receiptId: input.receiptId,
    sourceUrl: evidence.sourceUrl,
    exactByteHash: evidence.exactByteHash,
    capturedAt: evidence.capturedAt,
    extractionProfile: evidence.extractionProfile,
    normalizedTextHash: evidence.normalizedTextHash,
    retainedTextHash: evidence.retainedTextHash,
    fullCodePointCount: evidence.fullCodePointCount,
    retainedCodePointCount: evidence.retainedCodePointCount,
    truncated: evidence.truncated,
    page: { offset, limit: pageSize, text, matchOffsets },
    nextCursor,
  }
}
