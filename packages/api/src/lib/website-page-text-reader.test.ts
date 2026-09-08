import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { listWebsitePageText, readWebsitePageText } from './website-page-text-reader'

const receiptId = '975140d8-5af9-4c2d-9132-40b5cf6f5962'
const sourceUrl = 'https://example.com/details'
const text = `${'A'.repeat(4_000)} searchable fact ${'😀'.repeat(1_000)}`
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const exactByteHash = 'c'.repeat(64)
const retainedTextHash = sha256(text)

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    requestHash: 'b'.repeat(64),
    researchSnapshot: {
      schemaVersion: 1,
      sourceId: 'run-a',
      pages: [{ url: sourceUrl, depth: 1, byteSize: 123, normalizedHash: exactByteHash }],
      pageTextEvidence: [
        {
          sourceUrl,
          exactByteHash,
          capturedAt: '2026-09-08T10:00:00.000Z',
          extractionProfile: 'static-html-v1',
          text,
          normalizedTextHash: retainedTextHash,
          retainedTextHash,
          fullCodePointCount: [...text].length,
          retainedCodePointCount: [...text].length,
          truncated: false,
        },
      ],
    },
    ...overrides,
  }
}

function client(value: ReturnType<typeof receipt> | null = receipt()) {
  return {
    intakeWebsiteResearchReceipt: { findFirst: vi.fn().mockResolvedValue(value) },
  } as unknown as Parameters<typeof readWebsitePageText>[1] & {
    intakeWebsiteResearchReceipt: { findFirst: ReturnType<typeof vi.fn> }
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    runId: 'run-a',
    receiptId,
    sourceUrl,
    expectedExactByteHash: exactByteHash,
    expectedRetainedTextHash: retainedTextHash,
    pageSize: 2_000,
    ...overrides,
  }
}

const listInput = () => ({ tenantId: 'tenant-a', venueId: 'venue-a', runId: 'run-a', receiptId })

describe('website page text reader', () => {
  it('lists validated page metadata without returning retained text', async () => {
    const result = await listWebsitePageText(listInput(), client())
    expect(result).toMatchObject({
      status: 'RECORDED',
      sourceId: 'run-a',
      pages: [{ sourceUrl, exactByteHash, retainedTextHash }],
    })
    expect(result.pages[0]).not.toHaveProperty('text')
  })
  it('reads and searches retained prose with code-point bounded pagination', async () => {
    const db = client()
    const first = await readWebsitePageText(input(), db)
    const searched = await readWebsitePageText(input({ search: 'searchable fact' }), db)
    const second = await readWebsitePageText(input({ cursor: first.nextCursor }), db)

    expect(first).toMatchObject({
      status: 'RECORDED',
      exactByteHash,
      retainedTextHash,
      page: { offset: 0, limit: 2_000 },
    })
    expect(second.status === 'RECORDED' && second.page.offset).toBe(2_000)
    expect(searched.status === 'RECORDED' && searched.page.text).toContain('searchable fact')
    expect(searched.status === 'RECORDED' && searched.page.matchOffsets).toHaveLength(1)
  })

  it('truthfully reports that legacy receipts did not record page text', async () => {
    const db = client(
      receipt({
        researchSnapshot: {
          schemaVersion: 1,
          sourceId: 'run-a',
          pages: [{ url: sourceUrl, normalizedHash: exactByteHash }],
        },
      }),
    )
    await expect(readWebsitePageText(input(), db)).resolves.toEqual({
      status: 'NOT_RECORDED',
      receiptId,
      sourceUrl,
    })
  })

  it('uses the exact tenant, venue, run, receipt, and successful outcome scope', async () => {
    const db = client(null)
    await expect(readWebsitePageText(input({ tenantId: 'tenant-b' }), db)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(db.intakeWebsiteResearchReceipt.findFirst).toHaveBeenCalledWith({
      where: {
        id: receiptId,
        tenantId: 'tenant-b',
        venueId: 'venue-a',
        runId: 'run-a',
        outcome: 'SUCCEEDED',
      },
      select: { requestHash: true, researchSnapshot: true },
    })
  })

  it('rejects forged/stale cursors and mismatched hashes or page provenance', async () => {
    const db = client()
    const first = await readWebsitePageText(input(), db)
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'))
    decoded.offset += 1
    await expect(
      readWebsitePageText(
        input({ cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url') }),
        db,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      readWebsitePageText(input({ cursor: first.nextCursor, search: 'changed' }), db),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      readWebsitePageText(input({ expectedRetainedTextHash: 'd'.repeat(64) }), db),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const wrongProvenance = client(
      receipt({
        researchSnapshot: {
          ...receipt().researchSnapshot,
          pages: [{ url: sourceUrl, normalizedHash: 'e'.repeat(64) }],
        },
      }),
    )
    await expect(readWebsitePageText(input(), wrongProvenance)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('rejects malformed stored evidence and never returns neighboring page text', async () => {
    const malformed = client(
      receipt({
        researchSnapshot: {
          pages: [{ url: sourceUrl, normalizedHash: exactByteHash }],
          pageTextEvidence: [
            { ...receipt().researchSnapshot.pageTextEvidence[0], retainedCodePointCount: 1 },
          ],
        },
      }),
    )
    await expect(readWebsitePageText(input(), malformed)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(
      readWebsitePageText(input({ sourceUrl: 'https://example.com/other' }), client()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects wrong snapshot versions, wrong source IDs, and tampered list text', async () => {
    await expect(
      listWebsitePageText(
        listInput(),
        client(
          receipt({
            researchSnapshot: {
              ...receipt().researchSnapshot,
              schemaVersion: 2,
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      listWebsitePageText(
        listInput(),
        client(
          receipt({
            researchSnapshot: {
              ...receipt().researchSnapshot,
              sourceId: 'another-run',
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      listWebsitePageText(
        listInput(),
        client(
          receipt({
            researchSnapshot: {
              ...receipt().researchSnapshot,
              pageTextEvidence: [
                { ...receipt().researchSnapshot.pageTextEvidence[0], text: `${text}tampered` },
              ],
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('uses exact case-sensitive search and code-point offsets', async () => {
    const unicodeText = `${'😀'.repeat(10)} İ Exact exact`
    const unicodeHash = sha256(unicodeText)
    const db = client(
      receipt({
        researchSnapshot: {
          schemaVersion: 1,
          sourceId: 'run-a',
          pages: [{ url: sourceUrl, normalizedHash: exactByteHash }],
          pageTextEvidence: [
            {
              ...receipt().researchSnapshot.pageTextEvidence[0],
              text: unicodeText,
              normalizedTextHash: unicodeHash,
              retainedTextHash: unicodeHash,
              fullCodePointCount: [...unicodeText].length,
              retainedCodePointCount: [...unicodeText].length,
            },
          ],
        },
      }),
    )
    const exact = await readWebsitePageText(
      input({ expectedRetainedTextHash: unicodeHash, search: 'Exact', pageSize: 10 }),
      db,
    )
    const lower = await readWebsitePageText(
      input({ expectedRetainedTextHash: unicodeHash, search: 'EXACT', pageSize: 10 }),
      db,
    )
    expect(exact.status === 'RECORDED' && exact.page.matchOffsets).toEqual([2])
    expect(lower.status === 'RECORDED' && lower.page.offset).toBe(0)
    expect(lower.status === 'RECORDED' && lower.page.matchOffsets).toEqual([])
  })
})
