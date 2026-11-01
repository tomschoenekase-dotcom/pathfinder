import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { getVenueBotConfigurationAction, listPersonalityProfilesAction } from '@pathfinder/db'
import { assertVenueInGrant } from '../grants'
import type { OperatorReadTool } from '../registry'

export const venueBotConfigurationReadTools: readonly OperatorReadTool[] = [
  {
    name: 'venues.get_bot_configuration',
    capability: 'venues:read',
    async handler(raw, context) {
      const args = OPERATOR_MCP_INPUTS['venues.get_bot_configuration'].parse(raw)
      await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
      return getVenueBotConfigurationAction(args, context.database)
    },
  },
  {
    name: 'venues.list_personality_profiles',
    capability: 'venues:read',
    async handler(raw, context) {
      const args = OPERATOR_MCP_INPUTS['venues.list_personality_profiles'].parse(raw)
      await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
      return { items: await listPersonalityProfilesAction(args, context.database), complete: true }
    },
  },
]
