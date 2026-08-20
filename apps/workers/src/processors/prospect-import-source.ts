import { createHash } from 'node:crypto'

import * as unzipper from 'unzipper'
// Node16 module interop requires this form for SheetJS in both tsc and Vitest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import XLSX = require('xlsx')

import { readProspectImportUpload } from '@pathfinder/api/prospect-import-storage'
import { db, stageProspectImportRowsAction } from '@pathfinder/db'

const MAX_RAW_BYTES = 25 * 1024 * 1024
const MAX_EXPANDED_BYTES = 150 * 1024 * 1024
const MAX_SHEETS = 100
const MAX_ROWS = 100_000
const MAX_COLUMNS = 100
const MAX_CELL_CHARACTERS = 10_000
const MAX_ROW_BYTES = 256 * 1024

const FIELD_KEYS = new Set([
  'venueName',
  'organizationName',
  'venueType',
  'venueSubtype',
  'city',
  'region',
  'country',
  'website',
  'generalEmail',
  'contactName',
  'contactTitle',
  'contactEmail',
  'phone',
  'ownerSize',
  'locationCount',
  'venueSize',
  'shortDescription',
  'fitScore',
  'fitReason',
  'primaryUseCase',
  'outreachPriority',
  'personalizationHook',
  'researchConfidence',
  'researchDate',
  'sourceUrls',
  'notes',
  'territory',
])

function inputJson(value: unknown): object | unknown[] {
  return JSON.parse(JSON.stringify(value ?? [])) as object | unknown[]
}

async function immutableSource(importId: string) {
  const prospectImport = await db.prospectImport.findUnique({ where: { id: importId } })
  if (
    !prospectImport ||
    !prospectImport.sourceObjectKey ||
    !prospectImport.sourceObjectVersion ||
    !prospectImport.sourceObjectGeneration
  ) {
    throw new Error('Prospect import immutable source is not ready')
  }
  if (prospectImport.cancelRequestedAt) throw new Error('Prospect import was cancelled')
  return prospectImport
}

async function readBoundedSource(key: string, versionId: string) {
  const body = await readProspectImportUpload({ key, versionId })
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of body) {
    bytes += chunk.byteLength
    if (bytes > MAX_RAW_BYTES) throw new Error('Prospect workbook exceeds the raw byte limit')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, bytes)
}

async function expandedBytes(buffer: Buffer, fileType: string) {
  if (fileType !== 'xlsx') return buffer.byteLength
  const archive = await unzipper.Open.buffer(buffer)
  if (archive.files.length > 10_000) throw new Error('XLSX contains too many archive entries')
  let total = 0
  for (const file of archive.files) {
    total += file.uncompressedSize
    if (total > MAX_EXPANDED_BYTES) throw new Error('XLSX exceeds the expanded byte limit')
  }
  return total
}

function workbookFrom(buffer: Buffer) {
  return XLSX.read(buffer, {
    type: 'buffer',
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    cellDates: false,
    dense: true,
  })
}

function sheetShape(sheet: XLSX.WorkSheet) {
  if (!sheet['!ref']) return { rows: 0, columns: [] as string[] }
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const rows = Math.max(0, range.e.r - range.s.r)
  const width = range.e.c - range.s.c + 1
  if (width > MAX_COLUMNS) throw new Error('Workbook sheet exceeds the column limit')
  const header = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    range: range.s.r,
    blankrows: false,
    raw: false,
  })[0]
  const columns = (header ?? []).map((value, index) => {
    const label = String(value ?? `column_${index + 1}`)
      .trim()
      .slice(0, 300)
    return label || `column_${index + 1}`
  })
  return { rows, columns }
}

function inertCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  const text = String(value)
  if (text.length > MAX_CELL_CHARACTERS)
    throw new Error('Workbook cell exceeds the character limit')
  return text
}

export async function inspectProspectWorkbookBytes(buffer: Buffer, fileType: 'csv' | 'xlsx') {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_RAW_BYTES) {
    throw new Error('Prospect workbook exceeds the raw byte limit')
  }
  const expanded = await expandedBytes(buffer, fileType)
  const workbook = workbookFrom(buffer)
  if (!workbook.SheetNames.length || workbook.SheetNames.length > MAX_SHEETS) {
    throw new Error('Workbook must contain between 1 and 100 sheets')
  }
  let totalRows = 0
  const sheets = workbook.SheetNames.map((sheetName: string, sheetIndex: number) => {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error('Workbook sheet is missing')
    const shape = sheetShape(sheet)
    totalRows += shape.rows
    if (totalRows > MAX_ROWS) throw new Error('Workbook exceeds the total row limit')
    return { sheetName: sheetName.slice(0, 300), sheetIndex, ...shape }
  })
  return { expanded, workbook, sheets, totalRows }
}

function normalizedRow(
  source: Record<string, string | number | boolean | null>,
  mappingValue: unknown,
  sheetName: string,
) {
  if (!mappingValue || typeof mappingValue !== 'object' || Array.isArray(mappingValue)) {
    throw new Error('Prospect import mapping is invalid')
  }
  const mapping = mappingValue as Record<string, unknown>
  const output: Record<string, unknown> = { venueName: '', territory: sheetName }
  for (const [field, column] of Object.entries(mapping)) {
    if (!FIELD_KEYS.has(field) || typeof column !== 'string') continue
    const value = source[column]
    if (value === null || value === undefined || value === '') continue
    if (field === 'sourceUrls') {
      output[field] = String(value)
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20)
    } else {
      output[field] = String(value).trim()
    }
  }
  if (!output.territory) output.territory = sheetName
  return output
}

export async function inspectProspectImportSource(importId: string) {
  const prospectImport = await immutableSource(importId)
  const buffer = await readBoundedSource(
    prospectImport.sourceObjectKey!,
    prospectImport.sourceObjectVersion!,
  )
  if (buffer.byteLength !== prospectImport.fileSize) throw new Error('Workbook size drift detected')
  const { expanded, sheets, totalRows } = await inspectProspectWorkbookBytes(
    buffer,
    prospectImport.fileType === 'xlsx' ? 'xlsx' : 'csv',
  )
  await db.$transaction(async (tx) => {
    const current = await tx.prospectImport.findUnique({ where: { id: importId } })
    if (!current || current.cancelRequestedAt) throw new Error('Import inspection was cancelled')
    await tx.prospectImportSheet.deleteMany({ where: { importId } })
    await tx.prospectImportSheet.createMany({
      data: sheets.map((sheet) => ({
        importId,
        sheetName: sheet.sheetName,
        sheetIndex: sheet.sheetIndex,
        detectedRows: sheet.rows,
        columns: sheet.columns,
      })),
    })
    await tx.prospectImport.update({
      where: { id: importId },
      data: { expandedSizeBytes: expanded, totalRows, progressCursor: 'INSPECTED' },
    })
  })
  return { sheets: sheets.length, totalRows, expandedBytes: expanded }
}

export async function stageProspectImportSource(
  importId: string,
  renewLease?: () => Promise<void>,
) {
  const prospectImport = await immutableSource(importId)
  if (prospectImport.progressCursor !== 'MAPPED') throw new Error('Import mapping is not ready')
  const selected = await db.prospectImportSheet.findMany({
    where: { importId, selected: true },
    orderBy: { sheetIndex: 'asc' },
  })
  if (!selected.length) throw new Error('No workbook sheets were selected')
  const buffer = await readBoundedSource(
    prospectImport.sourceObjectKey!,
    prospectImport.sourceObjectVersion!,
  )
  await expandedBytes(buffer, prospectImport.fileType)
  const workbook = workbookFrom(buffer)
  const actor = {
    type: 'HUMAN' as const,
    id: prospectImport.createdBy,
    role: 'PLATFORM_ADMIN' as const,
  }
  let staged = 0
  let quarantined = 0
  for (const selectedSheet of selected) {
    const sheet = workbook.Sheets[selectedSheet.sheetName]
    if (!sheet) throw new Error('Selected workbook sheet disappeared')
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: false,
      dateNF: 'yyyy-mm-dd',
      blankrows: false,
    })
    for (let offset = 0; offset < rows.length; offset += 250) {
      const current = await db.prospectImport.findUnique({
        where: { id: importId },
        select: { cancelRequestedAt: true },
      })
      if (current?.cancelRequestedAt) throw new Error('Import staging was cancelled')
      const batch: Array<{
        sheetName: string
        originalRowNumber: number
        sourceValues: Record<string, string | number | boolean | null>
        normalizedValues: { venueName: string }
      }> = []
      for (const [index, raw] of rows.slice(offset, offset + 250).entries()) {
        const originalRowNumber = offset + index + 2
        try {
          if (Object.keys(raw).length > MAX_COLUMNS) throw new Error('row exceeds the column limit')
          const sourceValues = Object.fromEntries(
            Object.entries(raw).map(([column, value]) => [column.slice(0, 300), inertCell(value)]),
          )
          if (Buffer.byteLength(JSON.stringify(sourceValues), 'utf8') > MAX_ROW_BYTES) {
            throw new Error('row exceeds the encoded-size limit')
          }
          batch.push({
            sheetName: selectedSheet.sheetName,
            originalRowNumber,
            sourceValues,
            normalizedValues: normalizedRow(
              sourceValues,
              prospectImport.mapping,
              selectedSheet.sheetName,
            ) as { venueName: string },
          })
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unsafe workbook row'
          const fingerprint = createHash('sha256')
            .update(`${selectedSheet.sheetName}:${originalRowNumber}:${reason}`)
            .digest('hex')
          await db.prospectImportRow.upsert({
            where: {
              importId_sheetName_originalRowNumber: {
                importId,
                sheetName: selectedSheet.sheetName,
                originalRowNumber,
              },
            },
            create: {
              importId,
              sheetName: selectedSheet.sheetName,
              originalRowNumber,
              rowFingerprint: fingerprint,
              sourceValues: {},
              normalizedValues: {},
              status: 'QUARANTINED',
              errors: [`server-quarantine:${reason}`],
              errorCode: 'UNSAFE_SOURCE_ROW',
              errorMessage: reason.slice(0, 500),
              processedAt: new Date(),
            },
            update: {
              rowFingerprint: fingerprint,
              sourceValues: {},
              normalizedValues: {},
              status: 'QUARANTINED',
              errors: [`server-quarantine:${reason}`],
              errorCode: 'UNSAFE_SOURCE_ROW',
              errorMessage: reason.slice(0, 500),
              processedAt: new Date(),
            },
          })
          quarantined += 1
        }
      }
      if (batch.length) await stageProspectImportRowsAction({ importId, rows: batch, actor })
      if (renewLease) await renewLease()
      staged += batch.length
      await db.prospectImport.update({
        where: { id: importId },
        data: { progressCursor: `${selectedSheet.sheetIndex}:${offset + batch.length}` },
      })
    }
  }
  const counts = await db.prospectImportRow.groupBy({
    by: ['status'],
    where: { importId },
    _count: { _all: true },
  })
  const reportHash = createHash('sha256')
  let cursor: string | undefined
  for (;;) {
    const reportRows = await db.prospectImportRow.findMany({
      where: { importId },
      orderBy: { id: 'asc' },
      take: 1_000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sheetName: true,
        originalRowNumber: true,
        rowFingerprint: true,
        status: true,
        warnings: true,
        errors: true,
        duplicateMatches: true,
      },
    })
    if (!reportRows.length) break
    await db.prospectImportReportEntry.createMany({
      data: reportRows.map((row) => ({
        importId,
        importRowId: row.id,
        sheetName: row.sheetName,
        originalRowNumber: row.originalRowNumber,
        rowFingerprint: row.rowFingerprint,
        status: row.status,
        warnings: inputJson(row.warnings),
        errors: inputJson(row.errors),
        duplicateMatches: inputJson(row.duplicateMatches),
      })),
      skipDuplicates: true,
    })
    for (const row of reportRows) {
      reportHash.update(
        JSON.stringify([
          row.id,
          row.rowFingerprint,
          row.status,
          row.warnings,
          row.errors,
          row.duplicateMatches,
        ]),
      )
      reportHash.update('\n')
    }
    cursor = reportRows.at(-1)!.id
    if (renewLease) await renewLease()
  }
  const reportDigest = reportHash.digest('hex')
  await db.prospectImport.update({
    where: { id: importId },
    data: {
      progressCursor: 'DRY_RUN_READY',
      reconciliation: { staged, quarantined, counts },
      reportHash: reportDigest,
      reportObjectKey: `database-report/${importId}/${reportDigest}.csv`,
    },
  })
  return { staged, quarantined, counts }
}
