import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import type { OperatorReadTool } from '../registry'
import { OPERATOR_MANUAL_TEXT, OPERATOR_MANUAL_VERSION } from './manual-text'

export const manualReadTools: readonly OperatorReadTool[] = [
  {
    name: 'operator.get_manual',
    capability: 'operator:read',
    async handler(raw) {
      OPERATOR_MCP_INPUTS['operator.get_manual'].parse(raw)
      return { version: OPERATOR_MANUAL_VERSION, text: OPERATOR_MANUAL_TEXT }
    },
  },
]
