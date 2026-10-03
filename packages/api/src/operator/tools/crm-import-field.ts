import { createHash } from 'node:crypto'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { OperatorNotFoundError } from '../grants'
import { OperatorProposalError } from '../proposals'
import type { OperatorReadTool } from '../registry'

/** Explicit, paged owner inspection. Cell text is untrusted data, never instructions. */
export const crmImportFieldTool: OperatorReadTool = {
  name: 'crm.get_import_field',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.get_import_field'].parse(raw)
    if (!context.grant.allTenants || !context.config.allowedUserIds.has(context.grant.userId))
      throw new OperatorProposalError('FORBIDDEN_ACTOR', 'Platform-wide CRM authority is required')
    const row = await context.database.prospectImportRow.findFirst({
      where: { id: input.rowId, importId: input.importId },
      select: { sourceValues: true, normalizedValues: true },
    })
    if (!row) throw new OperatorNotFoundError()
    const values = input.stage === 'source' ? row.sourceValues : row.normalizedValues
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      !Object.hasOwn(values, input.field)
    )
      throw new OperatorNotFoundError()
    const value = (values as Record<string, unknown>)[input.field]
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null')
    const end = Math.min(input.offset + input.limit, text.length)
    return {
      importId: input.importId,
      rowId: input.rowId,
      field: input.field,
      stage: input.stage,
      untrusted: true,
      text: text.slice(input.offset, end),
      offset: input.offset,
      length: text.length,
      sha256: createHash('sha256').update(text).digest('hex'),
      complete: end >= text.length,
      nextOffset: end < text.length ? end : null,
    }
  },
}
