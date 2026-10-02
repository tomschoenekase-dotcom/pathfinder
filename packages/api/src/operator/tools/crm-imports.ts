import type { Prisma } from '@prisma/client'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { redactAddresses } from '../crm-projection'
import { computeImportPlan } from '../crm-import-plan'
import { OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  OperatorInvalidCursorError,
  pageResult,
  requireCursorInScope,
} from './page'

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
const cut = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)

const importSummarySelect = {
  id: true,
  fileName: true,
  fileType: true,
  fileSize: true,
  fileHash: true,
  mappingHash: true,
  packageSchemaVersion: true,
  status: true,
  totalRows: true,
  importedRows: true,
  failedRows: true,
  duplicateRows: true,
  createdAt: true,
  approvedAt: true,
  completedAt: true,
} satisfies Prisma.ProspectImportSelect

type ImportSummaryRow = Prisma.ProspectImportGetPayload<{ select: typeof importSummarySelect }>

function summaryView(row: ImportSummaryRow) {
  return {
    importId: row.id,
    // File names can carry an address or a client name; addresses are withheld like everywhere else.
    fileName: cut(redactAddresses(row.fileName), 200),
    fileType: cut(row.fileType, 80),
    fileSize: row.fileSize,
    fileHash: row.fileHash,
    mappingHash: row.mappingHash,
    mappingVersion: row.packageSchemaVersion,
    status: row.status,
    totalRows: row.totalRows,
    importedRows: row.importedRows,
    failedRows: row.failedRows,
    duplicateRows: row.duplicateRows,
    createdAt: row.createdAt.toISOString(),
    signedOffAt: iso(row.approvedAt),
    completedAt: iso(row.completedAt),
  }
}

const listImports: OperatorReadTool = {
  name: 'crm.list_imports',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_imports'].parse(raw)
    const database = context.database
    const where: Prisma.ProspectImportWhereInput = input.status ? { status: input.status } : {}
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    if (after) {
      // The cursor must name an import inside this same query, or it is refused outright.
      const anchor = await database.prospectImport.findFirst({
        where: { AND: [where, { id: after.id, createdAt: after.at }] },
        select: { id: true },
      })
      if (!anchor) throw new OperatorInvalidCursorError()
    }
    const rows = await database.prospectImport.findMany({
      where: {
        ...where,
        ...(after
          ? {
              OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: importSummarySelect,
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map(summaryView),
      rows.length > input.limit
        ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
        : null,
    )
  },
}

function stringList(value: unknown, max: number): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === 'string')
    .slice(0, max)
    .map((item) => cut(redactAddresses(item), 120))
}

function duplicateMatches(value: unknown) {
  const matches: Array<{
    organizationId: string
    name: string
    confidence: number
    reasons: string[]
  }> = []
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object') continue
    const match = item as Record<string, unknown>
    if (typeof match.organizationId !== 'string') continue
    matches.push({
      organizationId: cut(match.organizationId, 120),
      name: cut(redactAddresses(String(match.canonicalName ?? '')), 200),
      confidence: typeof match.confidence === 'number' ? match.confidence : 0,
      reasons: stringList(match.reasons, 10),
    })
    if (matches.length >= 10) break
  }
  return matches
}

const getImport: OperatorReadTool = {
  name: 'crm.get_import',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.get_import'].parse(raw)
    const database = context.database
    const row = await database.prospectImport.findUnique({
      where: { id: input.importId },
      select: {
        ...importSummarySelect,
        validRows: true,
        warningRows: true,
        sheets: {
          orderBy: { sheetIndex: 'asc' },
          take: 100,
          select: { sheetName: true, detectedRows: true, selected: true },
        },
      },
    })
    if (!row) throw new OperatorNotFoundError()

    const rowWhere: Prisma.ProspectImportRowWhereInput = {
      importId: input.importId,
      ...(input.rowStatus ? { status: input.rowStatus } : {}),
    }
    await requireCursorInScope(input.cursor, (id) =>
      database.prospectImportRow.findFirst({
        where: { AND: [rowWhere, { id }] },
        select: { id: true },
      }),
    )
    const [plan, rows] = await Promise.all([
      computeImportPlan(database, row),
      database.prospectImportRow.findMany({
        where: rowWhere,
        orderBy: { id: 'asc' },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          sheetName: true,
          originalRowNumber: true,
          rowFingerprint: true,
          status: true,
          decision: true,
          warnings: true,
          errors: true,
          duplicateMatches: true,
          errorCode: true,
          importedOrganizationId: true,
          importedVenueId: true,
          importedContactId: true,
          processedAt: true,
        },
      }),
    ])
    const { counts, rowTotal } = plan
    const page = rows.slice(0, input.limit)
    return {
      import: {
        ...summaryView(row),
        validRows: row.validRows,
        warningRows: row.warningRows,
        planHash: plan.planHash,
        importableRows: plan.importableRows,
        sheets: row.sheets.map((sheet) => ({
          sheetName: cut(sheet.sheetName, 300),
          detectedRows: sheet.detectedRows,
          selected: sheet.selected,
        })),
      },
      dispositions: {
        counts,
        rowTotal,
        // Every staged row is in exactly one disposition, so the sum must equal the recorded total.
        reconciled: rowTotal === row.totalRows,
      },
      rows: pageResult(
        page.map((entry) => ({
          rowId: entry.id,
          sheetName: cut(entry.sheetName, 300),
          originalRowNumber: entry.originalRowNumber,
          rowFingerprint: entry.rowFingerprint,
          status: entry.status,
          decision: entry.decision,
          warnings: stringList(entry.warnings, 20),
          errors: stringList(entry.errors, 20),
          duplicateMatches: duplicateMatches(entry.duplicateMatches),
          errorCode: entry.errorCode ? cut(entry.errorCode, 100) : null,
          receipt: {
            organizationId: entry.importedOrganizationId,
            venueId: entry.importedVenueId,
            contactId: entry.importedContactId,
          },
          processedAt: iso(entry.processedAt),
        })),
        rows.length > input.limit ? page.at(-1)!.id : null,
      ),
    }
  },
}

export const crmImportReadTools: readonly OperatorReadTool[] = [listImports, getImport]
