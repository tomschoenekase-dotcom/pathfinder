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
 * Not yet present because no canonical domain action exists for them: crm.propose_campaign_membership,
 * customers.propose_invite and support.propose_triage.
 */
export const OPERATOR_PROPOSAL_KINDS: readonly AnyOperatorProposalKind[] = [
  appearanceUpdateKind,
  appearanceGuestActionsKind,
  crmOutreachDraftKind,
  crmOutreachLogKind,
  crmStageChangeKind,
  venuesCreateKind,
  venuesKnowledgeKind,
  venuesUpdateKind,
  venuesPackageImportKind,
  venuesContentChangesetKind,
  venuesSourceKind,
  sourceConnectionKind,
  venuesPublishKind,
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
