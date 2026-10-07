import { describe, expect, it, vi } from 'vitest'

import {
  approveProspectImportAction,
  assertProspectImportMappingSafe,
  configureProspectImportMappingAction,
  parseProspectImportDate,
  stageProspectImportRowsAction,
} from './prospect-actions'

const actor = { type: 'HUMAN' as const, id: 'user_owner', role: 'PLATFORM_ADMIN' as const }

function stageClient(existingRows: Array<Record<string, unknown>> = []) {
  const created: Array<Record<string, unknown>> = []
  const tx = {
    prospectImport: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'import-1', status: 'DRAFT', sourceObjectKey: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    prospectImportSheet: { findMany: vi.fn().mockResolvedValue([{ sheetName: 'Data' }]) },
    prospectImportRow: {
      findMany: vi.fn().mockResolvedValue(existingRows),
      createMany: vi.fn().mockImplementation(({ data }) => {
        created.push(...data)
        return Promise.resolve({ count: data.length })
      }),
      update: vi.fn().mockResolvedValue({}),
      groupBy: vi.fn().mockImplementation(() => {
        const counts = new Map<string, number>()
        for (const row of [...created, ...existingRows]) {
          const status = String(row.status)
          counts.set(status, (counts.get(status) ?? 0) + 1)
        }
        return Promise.resolve([...counts].map(([status, n]) => ({ status, _count: { _all: n } })))
      }),
    },
    prospectOrganization: { findMany: vi.fn().mockResolvedValue([]) },
  }
  const client = {
    $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)),
  }
  return { tx, client, created }
}

const row = (n: number, source: Record<string, unknown>, normalized: Record<string, unknown>) => ({
  sheetName: 'Data',
  originalRowNumber: n,
  sourceValues: source,
  normalizedValues: { venueName: 'Sample Venue', ...normalized },
})

describe('spreadsheet import safety', () => {
  it('keeps claimed Gmail state as unverified source data and rejects invented states', async () => {
    const { client, created } = stageClient()
    await stageProspectImportRowsAction(
      {
        importId: 'import-1',
        rows: [
          row(
            2,
            { Gmail: 'thread-example', Delivery: 'delivered' },
            {
              gmailThreadId: 'thread-example',
              claimedDeliveryState: 'delivered',
              claimedDraftState: 'reviewed',
            },
          ),
          row(
            3,
            { Gmail: 'thread-other', Delivery: 'opened' },
            {
              gmailThreadId: 'thread-other',
              claimedDeliveryState: 'opened',
            },
          ),
        ],
        actor,
      },
      client as never,
    )
    expect((created[0] as Record<string, unknown>).status).not.toBe('FAILED')
    expect((created[0] as Record<string, unknown>).normalizedValues).toMatchObject({
      gmailThreadId: 'thread-example',
      claimedDeliveryState: 'delivered',
    })
    expect((created[1] as Record<string, unknown>).status).toBe('FAILED')
    expect((created[1] as Record<string, unknown>).errors).toContain(
      'claimed-delivery-state-invalid',
    )
  })

  it('stores a formula-looking cell as inert text and flags it, never evaluating it', async () => {
    const { client, created } = stageClient()
    await stageProspectImportRowsAction(
      {
        importId: 'import-1',
        rows: [
          row(
            2,
            { Venue: '=HYPERLINK("https://evil.example","x")', Note: '@SUM(A1)' },
            {
              venueName: '=HYPERLINK("https://evil.example","x")',
              notes: '-2+3',
              contactName: '+cmd|calc',
            },
          ),
        ],
        actor,
      },
      client as never,
    )
    const stored = created[0] as Record<string, unknown>
    // The cell survives byte for byte as a string in both the raw and normalized copies.
    expect((stored.sourceValues as Record<string, unknown>).Venue).toBe(
      '=HYPERLINK("https://evil.example","x")',
    )
    expect(typeof (stored.normalizedValues as Record<string, unknown>).venueName).toBe('string')
    expect(stored.warnings).toContain('formula-like-text')
    expect(stored.status).toBe('WARNING')
  })

  it('does not flag a phone number that merely starts with a plus sign', async () => {
    const { client, created } = stageClient()
    await stageProspectImportRowsAction(
      {
        importId: 'import-1',
        rows: [row(2, { Phone: '+1 555 0100' }, { phone: '+1 555 0100' })],
        actor,
      },
      client as never,
    )
    expect((created[0] as Record<string, unknown>).warnings).not.toContain('formula-like-text')
  })

  it('validates dates: an invalid or impossible research date is flagged and read as no date', async () => {
    expect(parseProspectImportDate('2026-02-28')).toEqual(new Date('2026-02-28T00:00:00.000Z'))
    expect(parseProspectImportDate('2026-09-30T12:00:00Z')).toBeInstanceOf(Date)
    expect(parseProspectImportDate('2026-02-31')).toBeNull()
    expect(parseProspectImportDate('13/45/2026')).toBeNull()
    expect(parseProspectImportDate('yesterday')).toBeNull()
    expect(parseProspectImportDate('   ')).toBeNull()

    const { client, created } = stageClient()
    await stageProspectImportRowsAction(
      {
        importId: 'import-1',
        rows: [
          row(2, { Date: '2026-02-31' }, { researchDate: '2026-02-31' }),
          row(3, { Date: '2026-02-27' }, { researchDate: '2026-02-27' }),
        ],
        actor,
      },
      client as never,
    )
    expect((created[0] as Record<string, unknown>).warnings).toContain('research-date-invalid')
    expect((created[1] as Record<string, unknown>).warnings).not.toContain('research-date-invalid')
  })

  it('validates encoding: a replacement character warns and a NUL byte fails the row', async () => {
    const { client, created } = stageClient()
    await stageProspectImportRowsAction(
      {
        importId: 'import-1',
        rows: [
          row(2, { Venue: 'Caf\uFFFD' }, { venueName: 'Caf\uFFFD' }),
          row(3, { Venue: 'Bad\u0000Name' }, { venueName: 'Bad\u0000Name' }),
        ],
        actor,
      },
      client as never,
    )
    const [mojibake, nul] = created as Array<Record<string, unknown>>
    expect(mojibake!.warnings).toContain('encoding-suspect')
    expect(mojibake!.status).toBe('WARNING')
    expect(nul!.errors).toContain('invalid-character')
    expect(nul!.status).toBe('FAILED')
  })

  it('refuses to map the company priority narrative onto the CRM priority', async () => {
    for (const column of ['company_priority', 'Company Priority', ' company-priority ']) {
      expect(() => assertProspectImportMappingSafe({ outreachPriority: column })).toThrow(
        /narrative text/u,
      )
    }
    expect(() =>
      assertProspectImportMappingSafe({ outreachPriority: 'Outreach priority' }),
    ).not.toThrow()
    expect(() => assertProspectImportMappingSafe({ notes: 'company_priority' })).not.toThrow()

    const configure = {
      $transaction: vi.fn(),
    }
    await expect(
      configureProspectImportMappingAction(
        {
          importId: 'import-1',
          mappingHash: 'a'.repeat(64),
          mapping: { venueName: 'Venue', outreachPriority: 'company_priority' },
          selectedSheets: ['Data'],
          actor,
        },
        configure as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(configure.$transaction).not.toHaveBeenCalled()
  })

  it('restarts idempotently: an already imported row is skipped and a staged row is updated in place', async () => {
    const { tx, client } = stageClient([
      { id: 'r-imported', sheetName: 'Data', originalRowNumber: 2, status: 'IMPORTED' },
      { id: 'r-staged', sheetName: 'Data', originalRowNumber: 3, status: 'VALID' },
    ])
    const result = await stageProspectImportRowsAction(
      {
        importId: 'import-1',
        rows: [
          row(2, { Venue: 'A' }, { venueName: 'A' }),
          row(3, { Venue: 'B' }, { venueName: 'B' }),
          row(4, { Venue: 'C' }, { venueName: 'C' }),
        ],
        actor,
      },
      client as never,
    )
    // Row 2 was committed before the restart and is left alone; row 3 is re-staged in place.
    expect(result.staged).toBe(2)
    expect(tx.prospectImportRow.update).toHaveBeenCalledTimes(1)
    expect(tx.prospectImportRow.update.mock.calls[0]![0].where).toEqual({ id: 'r-staged' })
    expect(tx.prospectImportRow.createMany.mock.calls[0]![0].data).toHaveLength(1)
  })

  it('reconciles row totals: every staged row lands in exactly one disposition', async () => {
    const { tx, client } = stageClient()
    const result = await stageProspectImportRowsAction(
      {
        importId: 'import-1',
        rows: [
          row(
            2,
            { Venue: 'A' },
            {
              venueName: 'A',
              website: 'https://a.example.test',
              sourceUrls: ['https://a.example.test'],
            },
          ),
          row(3, { Venue: 'B' }, { venueName: 'B' }),
          row(4, { Venue: '' }, { venueName: '' }),
        ],
        actor,
      },
      client as never,
    )
    const counted = result.counts.reduce((sum, item) => sum + item._count._all, 0)
    expect(counted).toBe(result.totalRows)
    expect(counted).toBe(3)
    const saved = tx.prospectImport.update.mock.calls[0]![0].data
    expect(saved.validRows + saved.warningRows + saved.duplicateRows + saved.failedRows).toBe(3)
  })

  it('replays an approval instead of approving twice', async () => {
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue({ id: 'import-1', status: 'APPROVED' }),
        update: vi.fn(),
      },
      prospectImportRow: { count: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)) }
    const result = await approveProspectImportAction(
      { importId: 'import-1', actor },
      client as never,
    )
    expect(result.replayed).toBe(true)
    expect(tx.prospectImport.update).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('refuses to approve while duplicate rows still await a decision', async () => {
    const tx = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'import-1',
          status: 'DRY_RUN_READY',
          sourceObjectKey: null,
          progressCursor: null,
        }),
        update: vi.fn(),
      },
      prospectImportRow: { count: vi.fn().mockResolvedValueOnce(2) },
      auditLog: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn((work: (t: typeof tx) => unknown) => work(tx)) }
    await expect(
      approveProspectImportAction({ importId: 'import-1', actor }, client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.prospectImport.update).not.toHaveBeenCalled()
  })
})
