import { createHash, createHmac } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IntakeFileExtractionReaderError,
  readIntakeFileExtractionSource,
} from './intake-file-extraction-reader'

const receiptId = '975140d8-5af9-4c2d-9132-40b5cf6f5962'
const text = `${'A'.repeat(4_000)} fact beyond the old preview boundary ${'B'.repeat(4_000)}`
const textHash = createHash('sha256').update(text).digest('hex')

function makeReceipt(overrides: Record<string, unknown> = {}) {
  return {
    requestHash: 'b'.repeat(64),
    extractedText: text,
    extractedTextHash: textHash,
    extractedCharacterCount: [...text].length,
    extractedLineCount: 1,
    sourceSha256: 'c'.repeat(64),
    sourceMimeType: 'text/plain',
    sourceObjectGeneration: '170d28ce-9f38-42bf-ae8d-d3d4d7d1d9a1',
    sourceStorageVersionId: 'version-1',
    upload: {
      objectGeneration: '170d28ce-9f38-42bf-ae8d-d3d4d7d1d9a1',
      storageVersionId: 'version-1',
      sha256: 'c'.repeat(64),
      mimeType: 'text/plain',
      status: 'AWAITING_REVIEW',
    },
    ...overrides,
  }
}

function makeClient(receipt: ReturnType<typeof makeReceipt> | null = makeReceipt()) {
  return {
    intakeFileExtractionReceipt: { findFirst: vi.fn().mockResolvedValue(receipt) },
  } as unknown as Parameters<typeof readIntakeFileExtractionSource>[1] & {
    intakeFileExtractionReceipt: { findFirst: ReturnType<typeof vi.fn> }
  }
}

function input(client: unknown, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    runId: 'run-a',
    receiptId,
    expectedExtractedTextHash: textHash,
    pageSize: 2_000,
    ...overrides,
  } as never
}

describe('intake file extraction source reader', () => {
  beforeEach(() => vi.clearAllMocks())

  it('makes text beyond the legacy 4,000 character preview reviewable with a bound continuation', async () => {
    const client = makeClient()
    const first = await readIntakeFileExtractionSource(input(client), client)
    const second = await readIntakeFileExtractionSource(
      input(client, { cursor: first.nextCursor }),
      client,
    )
    const third = await readIntakeFileExtractionSource(
      input(client, { cursor: second.nextCursor }),
      client,
    )

    expect(first.page.text).toHaveLength(2_000)
    expect(second.page.offset).toBe(2_000)
    expect(third.page.offset).toBe(4_000)
    expect(third.page.text).toContain('fact beyond the old preview boundary')
    expect(third).toMatchObject({
      receiptId,
      extractedTextHash: textHash,
      source: { sha256: 'c'.repeat(64), mimeType: 'text/plain' },
    })
    expect(third).not.toHaveProperty('originalUrl')
    expect(third).not.toHaveProperty('storageVersionId')
  })

  it('searches retained text beyond the initial page without interpreting malicious content', async () => {
    const client = makeClient(
      makeReceipt({
        extractedText: `${'<script>alert(1)</script>'.repeat(100)} exact phrase after.`,
      }),
    )
    const result = await readIntakeFileExtractionSource(
      input(client, { search: 'EXACT PHRASE', pageSize: 4_000 }),
      client,
    )

    expect(result.page.offset).toBeGreaterThan(0)
    expect(result.page.text).toContain('<script>alert(1)</script>')
    expect(result.page.matchOffsets).toEqual([result.page.text.indexOf('exact phrase')])
  })

  it('keeps pagination and search offsets aligned with the receipt code-point count', async () => {
    const unicodeText = `${'A'.repeat(3_998)}İ😀 searchable fact`
    const unicodeCodePoints = [...unicodeText]
    const unicodeHash = createHash('sha256').update(unicodeText).digest('hex')
    const client = makeClient(
      makeReceipt({
        extractedText: unicodeText,
        extractedTextHash: unicodeHash,
        extractedCharacterCount: unicodeCodePoints.length,
      }),
    )

    const first = await readIntakeFileExtractionSource(
      input(client, { expectedExtractedTextHash: unicodeHash, pageSize: 4_000 }),
      client,
    )
    const second = await readIntakeFileExtractionSource(
      input(client, {
        expectedExtractedTextHash: unicodeHash,
        pageSize: 4_000,
        cursor: first.nextCursor,
      }),
      client,
    )
    const searched = await readIntakeFileExtractionSource(
      input(client, {
        expectedExtractedTextHash: unicodeHash,
        pageSize: 4_000,
        search: 'searchable fact',
      }),
      client,
    )

    expect(first.extractedCharacterCount).toBe(unicodeCodePoints.length)
    expect(first.page).toMatchObject({
      offset: 0,
      text: unicodeCodePoints.slice(0, 4_000).join(''),
    })
    expect(second.page).toMatchObject({
      offset: 4_000,
      text: unicodeCodePoints.slice(4_000).join(''),
    })
    expect(searched.page.offset).toBe(3_001)
    expect(searched.page.matchOffsets).toEqual([1_000])
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'))).toMatchObject({
      v: 2,
      unit: 'codePoint',
      offset: 4_000,
    })
  })

  it('preserves contextual Unicode lowercase matching and caps matches per page', async () => {
    const prefix = 'hit '.repeat(101)
    const pagedText = `${prefix}${'A'.repeat(4_000 - prefix.length)}hit ΟΣ`
    const pagedHash = createHash('sha256').update(pagedText).digest('hex')
    const client = makeClient(
      makeReceipt({
        extractedText: pagedText,
        extractedTextHash: pagedHash,
        extractedCharacterCount: [...pagedText].length,
      }),
    )

    const first = await readIntakeFileExtractionSource(
      input(client, { expectedExtractedTextHash: pagedHash, pageSize: 4_000, search: 'hit' }),
      client,
    )
    const second = await readIntakeFileExtractionSource(
      input(client, {
        expectedExtractedTextHash: pagedHash,
        pageSize: 4_000,
        search: 'hit',
        cursor: first.nextCursor,
      }),
      client,
    )
    const greek = await readIntakeFileExtractionSource(
      input(client, { expectedExtractedTextHash: pagedHash, pageSize: 100, search: 'ΟΣ' }),
      client,
    )

    expect(first.page.matchOffsets).toHaveLength(100)
    expect(second.page).toMatchObject({ offset: 4_000, matchOffsets: [0] })
    expect(greek.page.text).toContain('ΟΣ')
    expect(greek.page.matchOffsets).toEqual([greek.page.text.indexOf('ΟΣ')])
  })

  it('fails closed for another tenant, stale source evidence, forged cursors, and oversized pages', async () => {
    const client = makeClient(null)
    await expect(
      readIntakeFileExtractionSource(input(client, { tenantId: 'tenant-b' }), client),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(client.intakeFileExtractionReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-b' }) }),
    )

    const staleClient = makeClient(
      makeReceipt({ upload: { ...makeReceipt().upload, storageVersionId: 'version-2' } }),
    )
    await expect(
      readIntakeFileExtractionSource(input(staleClient), staleClient),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })

    const validClient = makeClient()
    const first = await readIntakeFileExtractionSource(input(validClient), validClient)
    const legacyCursor = Buffer.from(
      JSON.stringify({
        offset: 2_000,
        searchHash: createHash('sha256').update('').digest('hex'),
        signature: createHmac('sha256', 'b'.repeat(64))
          .update(`${receiptId}:${textHash}:2000:${createHash('sha256').update('').digest('hex')}`)
          .digest('base64url'),
      }),
    ).toString('base64url')
    await expect(
      readIntakeFileExtractionSource(input(validClient, { cursor: legacyCursor }), validClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const forged = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'))
    forged.offset = 6_000
    const forgedCursor = Buffer.from(JSON.stringify(forged)).toString('base64url')
    await expect(
      readIntakeFileExtractionSource(input(validClient, { cursor: forgedCursor }), validClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    forged.offset = 2_000
    forged.unit = 'codeUnit'
    const wrongUnitCursor = Buffer.from(JSON.stringify(forged)).toString('base64url')
    await expect(
      readIntakeFileExtractionSource(input(validClient, { cursor: wrongUnitCursor }), validClient),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      readIntakeFileExtractionSource(
        input(validClient, { cursor: 'not-a-reader-cursor' }),
        validClient,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const changedHashClient = makeClient(makeReceipt({ extractedTextHash: 'd'.repeat(64) }))
    await expect(
      readIntakeFileExtractionSource(input(changedHashClient), changedHashClient),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      readIntakeFileExtractionSource(input(validClient, { pageSize: 4_001 }), validClient),
    ).rejects.toBeInstanceOf(IntakeFileExtractionReaderError)
  })
})
