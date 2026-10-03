import { mergeRouters } from '../../core'
import { adminProspectCrmCoreRouter } from './prospect-crm-core'
import { adminProspectCrmDuplicatesRouter } from './prospect-crm-duplicates'
import { adminProspectCrmDirectoryRouter } from './prospect-crm-directory'
import { adminProspectCrmImportRouter } from './prospect-crm-import'
import { adminProspectCrmImportRetryRouter } from './prospect-crm-import-retry'
import { adminProspectCrmImportRepairRouter } from './prospect-crm-import-repair'
import { adminProspectCrmAssistantDiscoveryRouter } from './prospect-crm-assistant-discovery'
import { adminProspectCrmIntelligenceRouter } from './prospect-crm-intelligence'
import { adminProspectCrmMutationsRouter } from './prospect-crm-mutations'
import { adminProspectCrmOutreachRouter } from './prospect-crm-outreach'
import { adminProspectCrmSavedViewsRouter } from './prospect-crm-saved-views'
import { adminProspectCrmSizeProposalsRouter } from './prospect-crm-size-proposals'
import { adminProspectCrmTerritoriesRouter } from './prospect-crm-territories'
import { adminProspectCrmThreadsRouter } from './prospect-crm-threads'

export const adminProspectCrmRouter = mergeRouters(
  adminProspectCrmCoreRouter,
  adminProspectCrmThreadsRouter,
  adminProspectCrmDirectoryRouter,
  adminProspectCrmMutationsRouter,
  adminProspectCrmTerritoriesRouter,
  adminProspectCrmImportRouter,
  adminProspectCrmImportRetryRouter,
  adminProspectCrmImportRepairRouter,
  adminProspectCrmDuplicatesRouter,
  adminProspectCrmAssistantDiscoveryRouter,
  adminProspectCrmIntelligenceRouter,
  adminProspectCrmOutreachRouter,
  adminProspectCrmSavedViewsRouter,
  adminProspectCrmSizeProposalsRouter,
)
