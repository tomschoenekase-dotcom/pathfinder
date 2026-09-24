import { describe, expect, it, vi } from 'vitest'

import {
  archiveProspectAction,
  approveProspectImportAction,
  beginProspectImportAction,
  commitProspectImportBatchAction,
  convertPublicInterestToProspectAction,
  createProspectAction,
  resolveProspectDuplicateAction,
  scanProspectDuplicatesAction,
  stageProspectImportRowsAction,
  updateProspectPipelineAction,
  ProspectActionError,
} from './prospect-actions'
import { prospectSha256 } from './prospect-normalization'

const actor = { type: 'HUMAN' as const, id: 'operator', role: 'PLATFORM_ADMIN' as const }

describe('prospect action safety boundaries', () => {
  it('reconciles an exact committed conversion after the losing transaction detects its duplicate', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const submissionId = 'submission-concurrent'
    const reason = 'Concurrent exact replay proof.'
    const replay = {
      operationId,
      operationHash: prospectSha256({ submissionId, reason }),
      organization: { id: 'organization-1' },
      venue: { id: 'venue-1' },
      contact: { id: 'contact-1' },
    }
    const client = {
      $transaction: vi
        .fn()
        .mockRejectedValue(
          new ProspectActionError('CONFLICT', 'A possible matching prospect already exists'),
        ),
      publicInterestProspectConversion: {
        findUnique: vi.fn().mockResolvedValue(replay),
      },
    }

    await expect(
      convertPublicInterestToProspectAction(
        { operationId, submissionId, reason, actor },
        client as never,
      ),
    ).resolves.toMatchObject({ replayed: true, conversion: replay })
  })

  it('rejects non-human or non-platform actors before database access', async () => {
    await expect(
      createProspectAction({
        organization: { canonicalName: 'Boundary Fixture' },
        actor: { type: 'HUMAN', id: 'staff', role: 'STAFF' } as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      convertPublicInterestToProspectAction({
        operationId: '11111111-1111-4111-8111-111111111111',
        submissionId: 'submission',
        actor: { type: 'HUMAN', id: 'staff', role: 'STAFF' } as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('requires reasons for terminal pipeline and archive decisions', async () => {
    await expect(
      updateProspectPipelineAction({
        organizationId: 'prospect',
        stage: 'LOST',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      archiveProspectAction({ organizationId: 'prospect', archived: true, reason: ' ', actor }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects unsafe merges rather than accepting an unmodeled resolution', async () => {
    await expect(
      resolveProspectDuplicateAction({
        candidateId: 'candidate',
        resolution: 'MERGED' as never,
        note: 'do not execute',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_MERGE' })
  })

  it('enforces spreadsheet size, hash, sheet, and batch limits before writes', async () => {
    await expect(
      beginProspectImportAction({
        fileName: 'too-large.xlsx',
        fileType: 'xlsx',
        fileSize: 25 * 1024 * 1024 + 1,
        fileHash: 'a'.repeat(64),
        mappingHash: 'b'.repeat(64),
        mapping: {},
        sheets: [{ sheetName: 'Data', sheetIndex: 0, detectedRows: 1, columns: [] }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      beginProspectImportAction({
        fileName: 'bad-hash.csv',
        fileType: 'csv',
        fileSize: 1,
        fileHash: 'not-a-hash',
        mappingHash: 'b'.repeat(64),
        mapping: {},
        sheets: [{ sheetName: 'Data', sheetIndex: 0, detectedRows: 1, columns: [] }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      stageProspectImportRowsAction({
        importId: 'import',
        rows: Array.from({ length: 251 }, (_, index) => ({
          sheetName: 'Data',
          originalRowNumber: index + 2,
          sourceValues: {},
          normalizedValues: { venueName: `Venue ${index}` },
        })),
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      stageProspectImportRowsAction({
        importId: 'import',
        rows: [
          {
            sheetName: 'Data',
            originalRowNumber: 2,
            sourceValues: { Venue: { formula: '=1+1' } },
            normalizedValues: { venueName: 'Unsafe nested cell' },
          },
        ],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('keeps a source-backed batch in draft and blocks approval before finalization', async () => {
    const prospectImport = {
      id: 'source-import',
      status: 'DRAFT',
      sourceObjectKey: 'immutable/workbook.xlsx',
      progressCursor: 'MAPPED',
    }
    const update = vi.fn().mockResolvedValue(prospectImport)
    const tx = {
      prospectImport: { findUnique: vi.fn().mockResolvedValue(prospectImport), update },
      prospectImportSheet: { findMany: vi.fn().mockResolvedValue([{ sheetName: 'Chicago' }]) },
      prospectOrganization: { findMany: vi.fn().mockResolvedValue([]) },
      prospectImportRow: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
        groupBy: vi.fn().mockResolvedValue([{ status: 'VALID', _count: { _all: 1 } }]),
      },
    }
    const client = {
      $transaction: async (operation: (value: typeof tx) => unknown) => operation(tx),
    }
    await stageProspectImportRowsAction(
      {
        importId: 'source-import',
        rows: [
          {
            sheetName: 'Chicago',
            originalRowNumber: 2,
            sourceValues: { venue_name: 'Storage Hall' },
            normalizedValues: { venueName: 'Storage Hall', city: 'Chicago' },
          },
        ],
        actor,
      },
      client as never,
    )
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT' }) }),
    )
    await expect(
      approveProspectImportAction({ importId: 'source-import', actor }, client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('scans beyond the former 20,000-organization duplicate ceiling in bounded chunks', async () => {
    const organizations = Array.from({ length: 20_001 }, (_, index) => ({
      id: `org-${String(index).padStart(6, '0')}`,
      normalizedName: `unique-${index}`,
      normalizedDomain: null,
      venues: [],
      contacts: [],
    }))
    let offset = 0
    const findMany = async ({ take }: { take: number }) => {
      const chunk = organizations.slice(offset, offset + take)
      offset += chunk.length
      return chunk
    }
    const auditLog = { create: async () => ({}) }
    const client = {
      prospectOrganization: { findMany, findFirst: async () => null },
      $transaction: async (callback: (tx: unknown) => unknown) => callback({ auditLog }),
    }

    await expect(
      scanProspectDuplicatesAction({ actor, prospectLimit: 20_001 }, client as never),
    ).resolves.toMatchObject({ organizationsScanned: 20_001, truncated: false })
    expect(offset).toBe(20_001)
  })

  it('keeps unexpected import failure details out of durable row state', async () => {
    const privateError = 'postgres://operator:secret@example.test/torchiko'
    const rowUpdateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
    const finalTransaction = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue({ cancelRequestedAt: null }),
        update: vi.fn().mockResolvedValue({ status: 'PARTIAL' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    }
    const client = {
      prospectImport: {
        findUnique: vi.fn().mockResolvedValue({ status: 'APPROVED', cancelRequestedAt: null }),
        update: vi.fn().mockResolvedValue({ status: 'PROCESSING' }),
      },
      prospectImportRow: {
        findMany: vi.fn().mockResolvedValue([{ id: 'row-1' }]),
        updateMany: rowUpdateMany,
        groupBy: vi.fn().mockResolvedValue([{ status: 'FAILED', _count: { _all: 1 } }]),
      },
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(new Error(privateError))
        .mockImplementationOnce((work) => work(finalTransaction)),
    }

    await expect(
      commitProspectImportBatchAction(
        { importId: 'import-1', limit: 1, workerId: 'worker-1', actor },
        client as never,
      ),
    ).resolves.toMatchObject({ processed: 0, failed: 1, done: true })
    expect(rowUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'UNEXPECTED',
          errorMessage: 'Prospect import failed (UNEXPECTED).',
        }),
      }),
    )
    expect(JSON.stringify(rowUpdateMany.mock.calls)).not.toContain(privateError)
  })
})
