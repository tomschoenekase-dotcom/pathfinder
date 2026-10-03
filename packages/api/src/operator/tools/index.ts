import type { OperatorReadTool } from '../registry'
import { controlTools } from './controls'
import { crmReadTools } from './crm'
import { crmAccountReadTools } from './crm-accounts'
import { crmCampaignReadTools } from './crm-campaigns'
import { crmOutreachContextReadTools } from './crm-outreach-context'
import { crmImportFieldTool } from './crm-import-field'
import { crmResumeImportTool } from './crm-import-resume'
import { crmImportReadTools } from './crm-imports'
import { crmStageCsvImportTool } from './crm-csv-import'
import { billingReadTools } from './billing'
import { blockingQuestionReadTools } from './blocking-questions'
import { routineReadTools } from './routines'
import { accessReadTools } from './access'
import { companyReadTools } from './company'
import { discoveryReadTools } from './discovery'
import { manualReadTools } from './manual'
import { mailReadTools } from './mail'
import { mailReconciliationTools } from './mail-reconciliation'
import { onboardingReadTools } from './onboarding'
import { operationReadTools } from './operations'
import { reportReadTools } from './reports'
import { supportReadTools } from './support'
import { updateReadTools } from './updates'
import { venueContentReadTools } from './venue-content'
import { venueReleaseReadTools } from './venue-releases'
import { venueSourceReadTools } from './venue-sources'
import { venueReadTools } from './venues'
import { attentionReadTools } from './attention'
import { evidenceReadTools } from './evidence'

/** Every read tool the operator adds beside the built-in proposal, autonomy and appearance reads. */
export const OPERATOR_READ_TOOLS: readonly OperatorReadTool[] = [
  ...crmReadTools,
  ...mailReadTools,
  ...mailReconciliationTools,
  ...crmAccountReadTools,
  ...crmOutreachContextReadTools,
  ...crmCampaignReadTools,
  ...crmImportReadTools,
  crmStageCsvImportTool,
  crmResumeImportTool,
  crmImportFieldTool,
  ...companyReadTools,
  ...reportReadTools,
  ...billingReadTools,
  ...routineReadTools,
  ...accessReadTools,
  ...venueReadTools,
  ...evidenceReadTools,
  ...attentionReadTools,
  ...venueSourceReadTools,
  ...venueContentReadTools,
  ...venueReleaseReadTools,
  ...supportReadTools,
  ...updateReadTools,
  ...manualReadTools,
  ...discoveryReadTools,
  ...onboardingReadTools,
  ...blockingQuestionReadTools,
  ...operationReadTools,
  ...controlTools,
]
