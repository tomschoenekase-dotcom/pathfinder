import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import {
  createProspectAction,
  db,
  commitProspectImportBatchAction,
  approveProspectImportAction,
} from '@pathfinder/db'

import type { OperatorCallContext } from '../registry'
import { parseBoundedCsv, stageCsvImport } from './crm-csv-import'

const enabled =
  process.env.RUN_CRM_CSV_IMPORT_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('operator CSV import (disposable database)', () => {
  const suffix = randomUUID().slice(0, 8)
  const owner = 'test-csv-owner'
  const actor = { type: 'HUMAN' as const, id: owner, role: 'PLATFORM_ADMIN' as const }
  const context = (allTenants: boolean): OperatorCallContext =>
    ({
      database: db,
      grant: {
        grantId: `csv-grant-${suffix}`,
        clientId: `csv-client-${suffix}`,
        userId: owner,
        allTenants,
        tenantIds: allTenants ? [] : ['other-tenant'],
        capabilities: ['crm:propose'],
      },
      config: { allowedUserIds: new Set([owner]) },
      requestId: randomUUID(),
      now: new Date('2026-10-02T12:00:00.000Z'),
    }) as unknown as OperatorCallContext

  afterAll(async () => db.$disconnect())

  it('imports 13 of 20 synthetic venues, skips 7 exact existing records and replays safely', async () => {
    for (let index = 1; index <= 7; index++) {
      await createProspectAction({
        organization: { canonicalName: `CSV Venue ${index} ${suffix}` },
        venue: { name: `CSV Venue ${index} ${suffix}`, city: 'Chicago' },
        actor,
      })
    }
    const csvText = [
      'Venue Name,City',
      ...Array.from({ length: 20 }, (_, index) => `CSV Venue ${index + 1} ${suffix},Chicago`),
    ].join('\n')
    const operationId = randomUUID()
    const input = { operationId, csvText }
    const staged = await stageCsvImport(input, context(true))
    expect(staged).toMatchObject({
      replayed: false,
      blocked: false,
      totalRows: 20,
      skippedDuplicates: 7,
      malformedRows: 0,
      unresolvedDuplicates: 0,
      importableRows: 13,
      addedRows: 0,
      next: { tool: 'crm.propose_import_commit', args: { expectedRows: 13 } },
    })
    expect(staged.next).not.toBeNull()
    expect(staged.next?.args.operationId).not.toBe(operationId)
    expect(
      OPERATOR_MCP_INPUTS['crm.propose_import_commit'].safeParse(staged.next?.args).success,
    ).toBe(true)
    const replay = await stageCsvImport(input, context(true))
    expect(replay).toMatchObject({
      importId: staged.importId,
      replayed: true,
      skippedDuplicates: 7,
    })
    expect(replay.next?.args.operationId).toBe(staged.next?.args.operationId)
    const savedManifest = (
      await db.prospectImport.findUniqueOrThrow({ where: { id: staged.importId } })
    ).packageManifest as Record<string, unknown>
    await db.prospectImport.update({
      where: { id: staged.importId },
      data: {
        packageManifest: { ...savedManifest, stagingComplete: false },
      },
    })
    await expect(
      approveProspectImportAction({ importId: staged.importId, actor }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await db.prospectImport.update({
      where: { id: staged.importId },
      data: {
        packageManifest: { ...savedManifest, sourceRows: 21 },
      },
    })
    await expect(
      approveProspectImportAction({ importId: staged.importId, actor }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await db.prospectImport.update({
      where: { id: staged.importId },
      data: {
        packageManifest: savedManifest,
      },
    })
    await approveProspectImportAction({ importId: staged.importId, actor })
    const committed = await commitProspectImportBatchAction({
      importId: staged.importId,
      limit: 100,
      actor,
    })
    expect(committed.done).toBe(true)
    expect(
      await db.prospectImportRow.count({
        where: { importId: staged.importId, status: 'IMPORTED' },
      }),
    ).toBe(13)
    const done = await stageCsvImport(input, context(true))
    expect(done).toMatchObject({
      importId: staged.importId,
      replayed: true,
      addedRows: 13,
      skippedDuplicates: 7,
    })
    expect(
      await db.prospectImport.count({
        where: { importIdentityHash: { not: '' }, id: staged.importId },
      }),
    ).toBe(1)
    await expect(
      stageCsvImport(
        { operationId, csvText: csvText.replace('CSV Venue 20', 'Changed Venue 20') },
        context(true),
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })

  it('blocks malformed rows and uncertain duplicates while refusing a limited grant', async () => {
    const csvText = `Venue Name,City\n,Chicago\nUncertain ${suffix},Chicago`
    await expect(
      stageCsvImport({ operationId: randomUUID(), csvText }, context(false)),
    ).rejects.toMatchObject({ code: 'SCOPE_REQUIRED' })
    const staged = await stageCsvImport({ operationId: randomUUID(), csvText }, context(true))
    expect(staged).toMatchObject({ blocked: true, totalRows: 2, malformedRows: 1, next: null })
  })

  it('skips only exact repeats inside a file and exposes unmapped columns', async () => {
    const name = `In File ${suffix}`
    const staged = await stageCsvImport(
      {
        operationId: randomUUID(),
        csvText: `Venue Name,City,Ignored Column\n${name},Chicago,same\n${name},Chicago,same`,
      },
      context(true),
    )
    expect(staged).toMatchObject({
      totalRows: 2,
      skippedDuplicates: 1,
      importableRows: 1,
      unmappedColumns: ['Ignored Column'],
      blocked: false,
    })
    const uncertain = await stageCsvImport(
      {
        operationId: randomUUID(),
        csvText: `Venue Name,City,Notes\n${name} Other,Chicago,first\n${name} Other,Chicago,changed`,
      },
      context(true),
    )
    expect(uncertain).toMatchObject({
      totalRows: 2,
      unresolvedDuplicates: 1,
      blocked: true,
      recovery: 'REVIEW_ROWS',
    })
  })

  it('supports quoted commas and newlines and rejects malformed quoting', () => {
    expect(parseBoundedCsv('Venue Name,City\n"A, B","New\nYork"').rows).toEqual([
      ['A, B', 'New\nYork'],
    ])
    expect(() => parseBoundedCsv('Venue Name\n"unfinished')).toThrow()
  })

  it('replays an attached file by file ID without downloading an expired URL', async () => {
    const operationId = randomUUID()
    const file = {
      file_id: `synthetic-${suffix}`,
      download_url: 'https://public.example.test/signed-one',
      mime_type: 'text/csv',
    }
    const first = await stageCsvImport(
      { operationId, file },
      context(true),
      async () => `Venue Name,City\nAttached ${suffix},Chicago`,
    )
    expect(first).toMatchObject({ blocked: false, totalRows: 1, importableRows: 1 })
    const replay = await stageCsvImport(
      { operationId, file: { ...file, download_url: 'https://public.example.test/expired' } },
      context(true),
      async () => {
        throw new Error('Replay must not download')
      },
    )
    expect(replay).toMatchObject({ importId: first.importId, replayed: true })
    await expect(
      stageCsvImport(
        { operationId, file: { ...file, file_id: 'different' } },
        context(true),
        async () => {
          throw new Error('Changed file must be rejected before download')
        },
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })

  it('concurrent retries of one operation cannot strand a completed stage', async () => {
    const operationId = randomUUID()
    const csvText = [
      'Venue Name,City',
      ...Array.from({ length: 12 }, (_, index) => `Concurrent ${index} ${suffix},Chicago`),
    ].join('\n')
    await Promise.all([
      stageCsvImport({ operationId, csvText }, context(true)),
      stageCsvImport({ operationId, csvText }, context(true)),
    ])
    const replay = await stageCsvImport({ operationId, csvText }, context(true))
    expect(replay).toMatchObject({
      blocked: false,
      totalRows: 12,
      stagedRows: 12,
      importableRows: 12,
    })
  })
})
