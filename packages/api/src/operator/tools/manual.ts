import { OPERATOR_MANUAL_SECTIONS, OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { z } from 'zod'

import { VenuePackagePayloadV3 } from '../../schemas/venue-package'
import {
  VENUE_AUTHORING_TEXT,
  VENUE_AUTHORING_VERSION,
} from '../venue-authoring/venue-authoring-text'
import type { OperatorReadTool } from '../registry'
import { OPERATOR_MANUAL_TEXT, OPERATOR_MANUAL_VERSION } from './manual-text'

let authoringSchema: Record<string, unknown> | undefined

/**
 * The accepted schemaVersion 3 package, generated from the validator the importer runs, so the
 * field list an agent reads cannot drift from what the server accepts.
 */
export function venuePackageAuthoringSchema(): Record<string, unknown> {
  authoringSchema ??= z.toJSONSchema(VenuePackagePayloadV3, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return authoringSchema
}

export const manualReadTools: readonly OperatorReadTool[] = [
  {
    name: 'operator.get_manual',
    capability: 'operator:read',
    async handler(raw) {
      const { section } = OPERATOR_MCP_INPUTS['operator.get_manual'].parse(raw)
      if (section === 'venue-authoring') {
        return {
          version: VENUE_AUTHORING_VERSION,
          section,
          text: VENUE_AUTHORING_TEXT,
          schema: venuePackageAuthoringSchema(),
        }
      }
      return {
        version: OPERATOR_MANUAL_VERSION,
        text: OPERATOR_MANUAL_TEXT,
        sections: [...OPERATOR_MANUAL_SECTIONS],
      }
    },
  },
]
