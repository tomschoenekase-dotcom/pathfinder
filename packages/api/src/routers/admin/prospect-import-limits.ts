export const PROSPECT_IMPORT_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxExpandedXlsxBytes: 150 * 1024 * 1024,
  maxSheets: 100,
  maxRows: 100_000,
  maxColumns: 100,
  maxCellCharacters: 10_000,
  maxSourceRowBytes: 256 * 1024,
  stageBatchRows: 250,
} as const

export class ProspectImportLimitError extends Error {}

function inspectCell(value: unknown, path: string): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value === 'string') {
    if (value.length > PROSPECT_IMPORT_LIMITS.maxCellCharacters) {
      throw new ProspectImportLimitError(`${path} exceeds the cell character limit`)
    }
    return
  }
  // Imported workbook cells are inert scalar evidence. Objects/arrays would make
  // limits and later rendering ambiguous, so reject them at the server boundary.
  throw new ProspectImportLimitError(`${path} must be a scalar workbook cell`)
}

export function assertProspectImportManifest(input: {
  fileSize: number
  expandedXlsxBytes?: number | undefined
  sheets: Array<{ detectedRows: number; columns: string[] }>
}): void {
  if (input.fileSize < 1 || input.fileSize > PROSPECT_IMPORT_LIMITS.maxFileBytes) {
    throw new ProspectImportLimitError('Import file size is outside the allowed range')
  }
  if (
    input.expandedXlsxBytes !== undefined &&
    (input.expandedXlsxBytes < input.fileSize ||
      input.expandedXlsxBytes > PROSPECT_IMPORT_LIMITS.maxExpandedXlsxBytes)
  ) {
    throw new ProspectImportLimitError('Expanded XLSX size is outside the allowed range')
  }
  if (!input.sheets.length || input.sheets.length > PROSPECT_IMPORT_LIMITS.maxSheets) {
    throw new ProspectImportLimitError('Selected sheet count is outside the allowed range')
  }
  let rows = 0
  for (const sheet of input.sheets) {
    if (sheet.columns.length > PROSPECT_IMPORT_LIMITS.maxColumns) {
      throw new ProspectImportLimitError('A selected sheet exceeds the column limit')
    }
    rows += sheet.detectedRows
  }
  if (rows > PROSPECT_IMPORT_LIMITS.maxRows) {
    throw new ProspectImportLimitError('Import exceeds the total row limit')
  }
}

export function assertProspectSourceRow(sourceValues: Record<string, unknown>): void {
  const entries = Object.entries(sourceValues)
  if (entries.length > PROSPECT_IMPORT_LIMITS.maxColumns) {
    throw new ProspectImportLimitError('Source row exceeds the column limit')
  }
  for (const [column, value] of entries) {
    if (column.length > 300) throw new ProspectImportLimitError('Source column name is too long')
    inspectCell(value, `Cell ${column}`)
  }
  if (
    Buffer.byteLength(JSON.stringify(sourceValues), 'utf8') >
    PROSPECT_IMPORT_LIMITS.maxSourceRowBytes
  ) {
    throw new ProspectImportLimitError('Source row exceeds the encoded-size limit')
  }
}

export function chunkProspectImportRows<T>(rows: Iterable<T>): T[][] {
  const chunks: T[][] = []
  let chunk: T[] = []
  for (const row of rows) {
    chunk.push(row)
    if (chunk.length === PROSPECT_IMPORT_LIMITS.stageBatchRows) {
      chunks.push(chunk)
      chunk = []
    }
  }
  if (chunk.length) chunks.push(chunk)
  return chunks
}
