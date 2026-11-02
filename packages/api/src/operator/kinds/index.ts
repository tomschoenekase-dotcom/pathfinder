import { CRM_OUTREACH_HISTORY_KINDS } from './crm-outreach-history'
import { crmRecordUpdateKind } from './crm-record-update'
import { VENUE_AI_CONFIGURATION_KINDS } from './ai-workload-configuration'
import { venueDistributionChangeKind } from './venue-distribution'
import { ENGAGEMENT_QUESTION_KINDS } from './engagement-questions'
import { VENUE_BOT_CONFIGURATION_KINDS } from './venue-bot-configuration'
import type { AnyOperatorProposalKind } from '../proposals'
import { appearanceUpdateKind } from './appearance'
import { appearanceGuestActionsKind } from './appearance-guest-actions'
import { CUSTOMER_KINDS } from './customers'
import { OPERATIONAL_UPDATE_KINDS } from './operational-updates'
import { CRM_CAMPAIGN_KINDS } from './crm-campaigns'
import { CRM_MAINTENANCE_KINDS } from './crm-maintenance'
import { CRM_PROSPECT_ADMIN_KINDS } from './crm-prospect-admin'
import { crmOrganizationMergeKind } from './crm-organization-merge'
import { SUPPORT_KINDS } from './support'
import { onboardingQuestionsKind } from './onboarding-questions'
import { OFFBOARDING_KINDS } from './offboarding-execution'
import { REPORT_KINDS } from './reports'
import { ROUTINE_KINDS } from './routines'
import { crmOutreachDraftKind } from './crm-outreach-draft'
import { crmOutreachLogKind } from './crm-outreach-log'
import { crmStageChangeKind } from './crm-stage-change'
import { venuesCreateKind } from './venues-create'
import { VENUE_GUEST_MODEL_KINDS } from './venues-guest-model'
import { venuesContentChangesetKind } from './venues-content-changeset'
import { venuesKnowledgeKind } from './venues-knowledge'
import { venuesPackageImportKind } from './venues-package-import'
import { venuesPublishKind } from './venues-publish'
import { venuesSourceKind } from './venues-source'
import { venuesUpdateKind } from './venues-update'
import { sourceConnectionKind } from './source-connections'

/**
 * Every proposal kind the operator can create. Add a kind by writing one file next to
 * `appearance.ts` and listing it here; `createKindRegistry` rejects duplicate tools.
 *
 * Each registered kind delegates to its canonical domain action; catalog entries alone do not
 * establish that a mutation is implemented.
 */
export const OPERATOR_PROPOSAL_KINDS: readonly AnyOperatorProposalKind[] = [
  appearanceUpdateKind,
  appearanceGuestActionsKind,
  ...CRM_OUTREACH_HISTORY_KINDS,
  crmRecordUpdateKind,
  crmOutreachDraftKind,
  crmOutreachLogKind,
  crmStageChangeKind,
  venuesCreateKind,
  venuesKnowledgeKind,
  ...VENUE_BOT_CONFIGURATION_KINDS,
  ...VENUE_AI_CONFIGURATION_KINDS,
  venueDistributionChangeKind,
  ...ENGAGEMENT_QUESTION_KINDS,
  venuesUpdateKind,
  venuesPackageImportKind,
  venuesContentChangesetKind,
  venuesSourceKind,
  sourceConnectionKind,
  venuesPublishKind,
  ...VENUE_GUEST_MODEL_KINDS,
  ...CRM_MAINTENANCE_KINDS,
  ...CRM_PROSPECT_ADMIN_KINDS,
  crmOrganizationMergeKind,
  ...CRM_CAMPAIGN_KINDS,
  ...SUPPORT_KINDS,
  ...CUSTOMER_KINDS,
  ...OFFBOARDING_KINDS,
  ...OPERATIONAL_UPDATE_KINDS,
  ...REPORT_KINDS,
  ...ROUTINE_KINDS,
  onboardingQuestionsKind,
]

export {
  CUSTOMER_KINDS,
  OFFBOARDING_KINDS,
  OPERATIONAL_UPDATE_KINDS,
  REPORT_KINDS,
  ROUTINE_KINDS,
  SUPPORT_KINDS,
  CRM_CAMPAIGN_KINDS,
  CRM_MAINTENANCE_KINDS,
  CRM_PROSPECT_ADMIN_KINDS,
  appearanceUpdateKind,
  appearanceGuestActionsKind,
  crmOutreachDraftKind,
  crmOutreachLogKind,
  crmStageChangeKind,
  venuesCreateKind,
  venuesKnowledgeKind,
  venuesContentChangesetKind,
  venuesSourceKind,
  venuesPublishKind,
  venuesUpdateKind,
  venuesPackageImportKind,
}
