import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  configureProspectImportMappingAction,
  prospectSha256,
  resumeIncompleteProspectImportDryRunAction,
} from '@pathfinder/db'
import { enqueueProspectImportStaging } from '@pathfinder/jobs'
import { CSV_IMPORT_FIELDS } from './crm-csv-import'
import { OperatorNotFoundError } from '../grants'
import { OperatorProposalError } from '../proposals'
import type { OperatorCallContext, OperatorReadTool } from '../registry'

export async function resumeImport(
  raw: unknown,
  context: OperatorCallContext,
  enqueue: (payload: { importId: string }) => Promise<unknown> = enqueueProspectImportStaging,
) {
  const input = OPERATOR_MCP_INPUTS['crm.resume_import'].parse(raw)
  if (!context.grant.allTenants || !context.config.allowedUserIds.has(context.grant.userId))
    throw new OperatorProposalError('FORBIDDEN_ACTOR', 'Platform-wide CRM authority is required')
  const row = await context.database.prospectImport.findUnique({ where: { id: input.importId } })
  if (!row) throw new OperatorNotFoundError()
  if (row.fileHash !== input.fileHash || row.mappingHash !== input.mappingHash)
    throw new OperatorProposalError(
      'ARGS_HASH_MISMATCH',
      'Import file or mapping changed; read crm.get_import again',
    )
  if (row.jobClaimExpiresAt && row.jobClaimExpiresAt > new Date())
    return { importId: row.id, queued: false, jobId: null, state: 'RUNNING' as const }
  if (input.mapping && input.selectedSheets) {
    if (
      !input.mapping.venueName ||
      Object.keys(input.mapping).some((field) => !CSV_IMPORT_FIELDS.has(field))
    )
      throw new OperatorProposalError(
        'ARGS_HASH_MISMATCH',
        'Map a venueName and supported import fields',
      )
    const sheets = await context.database.prospectImportSheet.findMany({
      where: { importId: row.id, sheetName: { in: input.selectedSheets } },
      select: { sheetName: true, columns: true },
    })
    if (
      sheets.length !== input.selectedSheets.length ||
      sheets.some(
        (sheet) =>
          !Array.isArray(sheet.columns) ||
          Object.values(input.mapping!).some(
            (column) => !(sheet.columns as unknown[]).includes(column),
          ),
      )
    )
      throw new OperatorProposalError(
        'ARGS_HASH_MISMATCH',
        'Mapping must name inspected columns in every selected sheet',
      )
    await configureProspectImportMappingAction(
      {
        importId: row.id,
        expectedFileHash: input.fileHash,
        expectedMappingHash: input.mappingHash,
        mapping: input.mapping,
        mappingHash: prospectSha256({
          mapping: input.mapping,
          selectedSheets: [...input.selectedSheets].sort(),
        }),
        selectedSheets: input.selectedSheets,
        actor: { type: 'HUMAN', id: context.grant.userId, role: 'PLATFORM_ADMIN' },
      },
      context.database,
    )
  }
  await resumeIncompleteProspectImportDryRunAction(
    {
      importId: row.id,
      actor: { type: 'HUMAN', id: context.grant.userId, role: 'PLATFORM_ADMIN' },
    },
    context.database,
  )
  const jobId = await enqueue({ importId: row.id })
  return {
    importId: row.id,
    queued: true,
    jobId: typeof jobId === 'string' ? jobId : null,
    state: 'QUEUED' as const,
  }
}

export const crmResumeImportTool: OperatorReadTool = {
  name: 'crm.resume_import',
  capability: 'crm:propose',
  handler: (raw, context) => resumeImport(raw, context),
}
