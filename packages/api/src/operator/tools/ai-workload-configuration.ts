import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { readVenueAiConfiguration } from '../ai-workload-configuration'
import { assertVenueInGrant } from '../grants'
import type { OperatorReadTool } from '../registry'

export const venueAiConfigurationReadTool: OperatorReadTool = {
  name: 'venues.get_ai_workload_configuration',
  capability: 'venues:read',
  async handler(raw, context) {
    const args = OPERATOR_MCP_INPUTS['venues.get_ai_workload_configuration'].parse(raw)
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    return readVenueAiConfiguration(args, context.database)
  },
}
