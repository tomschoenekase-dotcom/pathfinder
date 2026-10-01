import type { OperatorReadTool } from '../registry'
import { controlTools } from './controls'
import { crmReadTools } from './crm'
import { crmAccountReadTools } from './crm-accounts'
import { crmCampaignReadTools } from './crm-campaigns'
import { billingReadTools } from './billing'
import { companyReadTools } from './company'
import { discoveryReadTools } from './discovery'
import { manualReadTools } from './manual'
import { mailReadTools } from './mail'
import { onboardingReadTools } from './onboarding'
import { operationReadTools } from './operations'
import { reportReadTools } from './reports'
import { supportReadTools } from './support'
import { venueReadTools } from './venues'

/** Every read tool the operator adds beside the built-in proposal, autonomy and appearance reads. */
export const OPERATOR_READ_TOOLS: readonly OperatorReadTool[] = [
  ...crmReadTools,
  ...mailReadTools,
  ...crmAccountReadTools,
  ...crmCampaignReadTools,
  ...companyReadTools,
  ...reportReadTools,
  ...billingReadTools,
  ...venueReadTools,
  ...supportReadTools,
  ...manualReadTools,
  ...discoveryReadTools,
  ...onboardingReadTools,
  ...operationReadTools,
  ...controlTools,
]
