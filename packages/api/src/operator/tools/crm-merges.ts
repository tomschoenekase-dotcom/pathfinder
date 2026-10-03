import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { previewProspectOrganizationMergeAction, ProspectActionError } from '@pathfinder/db'

import { OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'

export const crmMergeReadTools: readonly OperatorReadTool[] = [
  {
    name: 'crm.preview_organization_merge',
    capability: 'crm:read',
    handler: async (raw, context) => {
      if (!context.grant.allTenants || !context.config.allowedUserIds.has(context.grant.userId)) {
        throw new OperatorNotFoundError()
      }
      const input = OPERATOR_MCP_INPUTS['crm.preview_organization_merge'].parse(raw)
      try {
        return await previewProspectOrganizationMergeAction(input, context.database)
      } catch (error) {
        if (error instanceof ProspectActionError && error.code === 'NOT_FOUND') {
          throw new OperatorNotFoundError()
        }
        throw error
      }
    },
  },
]
