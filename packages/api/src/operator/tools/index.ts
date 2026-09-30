import type { OperatorReadTool } from '../registry'
import { crmReadTools } from './crm'
import { manualReadTools } from './manual'
import { supportReadTools } from './support'
import { venueReadTools } from './venues'

/** Every read tool the operator adds beside the built-in proposal, autonomy and appearance reads. */
export const OPERATOR_READ_TOOLS: readonly OperatorReadTool[] = [
  ...crmReadTools,
  ...venueReadTools,
  ...supportReadTools,
  ...manualReadTools,
]
