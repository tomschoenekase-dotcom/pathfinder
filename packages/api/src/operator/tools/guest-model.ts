import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { assertVenueInGrant } from '../grants'
import { guestModelView } from '../guest-model'
import type { OperatorReadTool } from '../registry'

/** Which model answers one venue's visitor chat, where that comes from, and the allowed choices. */
const venuesGetGuestModel: OperatorReadTool = {
  name: 'venues.get_guest_model',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.get_guest_model'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    return guestModelView(context.database, input.tenantId, input.venueId)
  },
}

export const guestModelReadTools: readonly OperatorReadTool[] = [venuesGetGuestModel]
