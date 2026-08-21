import { mergeRouters } from '../../core'
import { adminProspectCrmCoreRouter } from './prospect-crm-core'
import { adminProspectCrmDuplicatesRouter } from './prospect-crm-duplicates'
import { adminProspectCrmDirectoryRouter } from './prospect-crm-directory'
import { adminProspectCrmImportRouter } from './prospect-crm-import'
import { adminProspectCrmImportRepairRouter } from './prospect-crm-import-repair'
import { adminProspectCrmIntelligenceRouter } from './prospect-crm-intelligence'
import { adminProspectCrmMutationsRouter } from './prospect-crm-mutations'
import { adminProspectCrmOutreachRouter } from './prospect-crm-outreach'
import { adminProspectCrmSavedViewsRouter } from './prospect-crm-saved-views'
import { adminProspectCrmTerritoriesRouter } from './prospect-crm-territories'

export const adminProspectCrmRouter = mergeRouters(
  adminProspectCrmCoreRouter,
  adminProspectCrmDirectoryRouter,
  adminProspectCrmMutationsRouter,
  adminProspectCrmTerritoriesRouter,
  adminProspectCrmImportRouter,
  adminProspectCrmImportRepairRouter,
  adminProspectCrmDuplicatesRouter,
  adminProspectCrmIntelligenceRouter,
  adminProspectCrmOutreachRouter,
  adminProspectCrmSavedViewsRouter,
)
