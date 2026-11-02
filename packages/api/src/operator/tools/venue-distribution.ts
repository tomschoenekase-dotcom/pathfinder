import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { readVenueDistributionState } from '@pathfinder/db'
import { assertVenueInGrant } from '../grants'
import type { OperatorReadTool } from '../registry'

/** Website/app embedding state and allowed origins; the same data as Visitor access. */
export const venueDistributionReadTool: OperatorReadTool = {
  name: 'venues.get_distribution',
  capability: 'venues:read',
  async handler(raw, context) {
    const args = OPERATOR_MCP_INPUTS['venues.get_distribution'].parse(raw)
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    const state = await readVenueDistributionState(context.database, args.tenantId, args.venueId)
    return { venueId: args.venueId, ...state, originsComplete: state.origins.length < 100 }
  },
}
