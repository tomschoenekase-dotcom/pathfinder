import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
// Node16 module interop requires this form for SheetJS in both tsc and Vitest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import XLSX = require('xlsx')

import {
  createProspectImportObjectKey,
  inspectProspectImportUpload,
  signProspectImportUpload,
} from '@pathfinder/api/prospect-import-storage'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { inspectProspectImportSource, stageProspectImportSource } from './prospect-import-source'

const enabled = process.env.RUN_LOCAL_PROSPECT_IMPORT_STORAGE_INTEGRATION === '1'

describe.skipIf(!enabled)('PC-local immutable prospect workbook pipeline', () => {
  afterAll(async () => db.$disconnect())

  it('uploads, verifies, inspects, stages, and snapshots a real XLSX', async () => {
    const suffix = randomUUID()
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        { venue_name: `Storage Hall ${suffix}`, city: 'Chicago', email: 'hello@example.test' },
        { venue_name: `Storage Museum ${suffix}`, city: 'Evanston', email: 'info@example.test' },
      ]),
      'Chicago',
    )
    const bytes = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    const fileHash = createHash('sha256').update(bytes).digest('hex')
    const mapping = { venueName: 'venue_name', city: 'city', contactEmail: 'email' }
    const mappingHash = createHash('sha256').update(JSON.stringify(mapping)).digest('hex')
    const generation = randomUUID()
    const key = createProspectImportObjectKey()
    const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    const signed = await signProspectImportUpload({
      key,
      generation,
      contentType,
      bytes: bytes.byteLength,
      checksumSha256: fileHash,
    })
    const upload = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.requiredHeaders,
      body: bytes,
    })
    expect(upload.status).toBe(200)
    const inspection = await inspectProspectImportUpload({
      key,
      generation,
      contentType,
      bytes: bytes.byteLength,
      checksumSha256: fileHash,
    })
    expect(inspection.state).toBe('verified')
    if (inspection.state !== 'verified') throw new Error('Expected immutable source verification')

    const importId = await withTenantIsolationBypass(async () => {
      const created = await db.prospectImport.create({
        data: {
          fileName: 'synthetic-storage.xlsx',
          fileType: 'xlsx',
          fileSize: bytes.byteLength,
          fileHash,
          mappingHash,
          importIdentityHash: createHash('sha256')
            .update(`${fileHash}:${mappingHash}`)
            .digest('hex'),
          mapping,
          sourceObjectKey: key,
          sourceObjectVersion: inspection.versionId,
          sourceObjectGeneration: generation,
          progressCursor: 'UPLOADED',
          createdBy: 'storage-integration',
        },
      })
      return created.id
    })

    await withTenantIsolationBypass(() => inspectProspectImportSource(importId))
    await withTenantIsolationBypass(async () => {
      await db.prospectImportSheet.updateMany({ where: { importId }, data: { selected: true } })
      await db.prospectImport.update({
        where: { id: importId },
        data: { progressCursor: 'MAPPED' },
      })
    })
    await withTenantIsolationBypass(() => stageProspectImportSource(importId))
    await withTenantIsolationBypass(async () => {
      const result = await db.prospectImport.findUniqueOrThrow({ where: { id: importId } })
      expect(result).toMatchObject({ totalRows: 2, progressCursor: 'DRY_RUN_READY' })
      expect(result.reportHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(await db.prospectImportRow.count({ where: { importId } })).toBe(2)
      expect(await db.prospectImportReportEntry.count({ where: { importId } })).toBe(2)
    })
  }, 30_000)
})
