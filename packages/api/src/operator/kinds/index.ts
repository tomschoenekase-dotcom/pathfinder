import type { AnyOperatorProposalKind } from '../proposals'
import { appearanceUpdateKind } from './appearance'
import { CUSTOMER_KINDS } from './customers'
import { CRM_CAMPAIGN_KINDS } from './crm-campaigns'
import { CRM_MAINTENANCE_KINDS } from './crm-maintenance'
import { SUPPORT_KINDS } from './support'
import { onboardingQuestionsKind } from './onboarding-questions'
import { crmOutreachDraftKind } from './crm-outreach-draft'
import { crmOutreachLogKind } from './crm-outreach-log'
import { crmStageChangeKind } from './crm-stage-change'
import { venuesCreateKind } from './venues-create'
import { venuesKnowledgeKind } from './venues-knowledge'
import { venuesPublishKind } from './venues-publish'

/**
 * Every proposal kind the operator can create. Add a kind by writing one file next to
 * `appearance.ts` and listing it here; `createKindRegistry` rejects duplicate tools.
 *
 * Not yet present because no canonical domain action exists for them: crm.propose_campaign_membership,
 * venues.propose_source, customers.propose_invite and support.propose_triage.
 */
export const OPERATOR_PROPOSAL_KINDS: readonly AnyOperatorProposalKind[] = [
  appearanceUpdateKind,
  crmOutreachDraftKind,
  crmOutreachLogKind,
  crmStageChangeKind,
  venuesCreateKind,
  venuesKnowledgeKind,
  venuesPublishKind,
  ...CRM_MAINTENANCE_KINDS,
  ...CRM_CAMPAIGN_KINDS,
  ...SUPPORT_KINDS,
  ...CUSTOMER_KINDS,
  onboardingQuestionsKind,
]

export {
  CUSTOMER_KINDS,
  SUPPORT_KINDS,
  CRM_CAMPAIGN_KINDS,
  CRM_MAINTENANCE_KINDS,
  appearanceUpdateKind,
  crmOutreachDraftKind,
  crmOutreachLogKind,
  crmStageChangeKind,
  venuesCreateKind,
  venuesKnowledgeKind,
  venuesPublishKind,
}
