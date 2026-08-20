import { describe, expect, it } from 'vitest'

import {
  archiveProspectAction,
  beginProspectImportAction,
  createProspectAction,
  resolveProspectDuplicateAction,
  scanProspectDuplicatesAction,
  stageProspectImportRowsAction,
  updateProspectPipelineAction,
} from './prospect-actions'

const actor = { type: 'HUMAN' as const, id: 'operator', role: 'PLATFORM_ADMIN' as const }

describe('prospect action safety boundaries', () => {
  it('rejects non-human or non-platform actors before database access', async () => {
    await expect(
      createProspectAction({
        organization: { canonicalName: 'Boundary Fixture' },
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
})
