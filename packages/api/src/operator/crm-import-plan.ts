import { createHash } from 'node:crypto'

import type { OperatorDatabase } from './audit'

/**
 * Prospect imports are staged, reviewed and committed by the existing admin services. The operator
 * only reads them and proposes the commit, so this file holds the one definition of what a commit
 * would act on: the file hash, the mapping hash and every staged row's identity, status and review
 * decision. The plan hash covers all of it, so a proposal approved for one plan cannot commit a
 * different one (a row re-staged, a duplicate decision changed, a different file).
 */

export const IMPORT_ROW_STATUSES = [
  'VALID',
  'WARNING',
  'DUPLICATE_REVIEW',
  'PROCESSING',
  'IMPORTED',
  'FAILED',
  'SKIPPED',
  'QUARANTINED',
] as const

export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number]
export type ImportDispositionCounts = Record<ImportRowStatus, number>

const PLAN_BATCH = 1_000

export type ImportPlan = Readonly<{
  planHash: string
  counts: ImportDispositionCounts
  rowTotal: number
  /** Rows a commit would create or link: VALID plus WARNING. */
  importableRows: number
}>

export function emptyDispositionCounts(): ImportDispositionCounts {
  return {
    VALID: 0,
    WARNING: 0,
    DUPLICATE_REVIEW: 0,
    PROCESSING: 0,
    IMPORTED: 0,
    FAILED: 0,
    SKIPPED: 0,
    QUARANTINED: 0,
  }
}

/** Counts every staged row by status, straight from the rows rather than the import's totals. */
export async function countImportRows(
  database: OperatorDatabase,
  importId: string,
): Promise<{ counts: ImportDispositionCounts; rowTotal: number }> {
  const grouped = await database.prospectImportRow.groupBy({
    by: ['status'],
    where: { importId },
    _count: { _all: true },
  })
  const counts = emptyDispositionCounts()
  let rowTotal = 0
  for (const row of grouped) {
    counts[row.status as ImportRowStatus] = row._count._all
    rowTotal += row._count._all
  }
  return { counts, rowTotal }
}

/** Streams the staged rows in id order into one SHA-256, a bounded page at a time. */
export async function computeImportPlan(
  database: OperatorDatabase,
  prospectImport: { id: string; fileHash: string; mappingHash: string },
): Promise<ImportPlan> {
  const hash = createHash('sha256')
  hash.update(
    `plan:v1\n${prospectImport.id}\n${prospectImport.fileHash}\n${prospectImport.mappingHash}\n`,
  )
  let cursor: string | undefined
  for (;;) {
    const rows = await database.prospectImportRow.findMany({
      where: { importId: prospectImport.id },
      orderBy: { id: 'asc' },
      take: PLAN_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        rowFingerprint: true,
        status: true,
        decision: true,
        targetOrganizationId: true,
        targetVenueId: true,
        targetContactId: true,
      },
    })
    if (rows.length === 0) break
    for (const row of rows) {
      hash.update(
        JSON.stringify([
          row.id,
          row.rowFingerprint,
          row.status,
          row.decision,
          row.targetOrganizationId,
          row.targetVenueId,
          row.targetContactId,
        ]),
      )
      hash.update('\n')
    }
    if (rows.length < PLAN_BATCH) break
    cursor = rows.at(-1)!.id
  }
  const { counts, rowTotal } = await countImportRows(database, prospectImport.id)
  return {
    planHash: hash.digest('hex'),
    counts,
    rowTotal,
    importableRows: counts.VALID + counts.WARNING,
  }
}
