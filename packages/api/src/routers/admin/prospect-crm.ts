import { mergeRouters } from '../../core'
import { adminProspectCrmChicagoRouter } from './prospect-crm-chicago'
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
import { adminProspectCrmThreadReadRouter } from './prospect-crm-thread-read'
import { adminProspectCrmSalesRouter } from './prospect-crm-sales'
import { adminProspectCrmCohortsRouter } from './prospect-crm-cohorts'

export const adminProspectCrmRouter = mergeRouters(
  adminProspectCrmChicagoRouter,
  adminProspectCrmCoreRouter,
  adminProspectCrmDirectoryRouter,
  adminProspectCrmMutationsRouter,
  adminProspectCrmTerritoriesRouter,
  adminProspectCrmThreadReadRouter,
  adminProspectCrmImportRouter,
  adminProspectCrmImportRepairRouter,
  adminProspectCrmDuplicatesRouter,
  adminProspectCrmIntelligenceRouter,
  adminProspectCrmOutreachRouter,
  adminProspectCrmSavedViewsRouter,
  adminProspectCrmSalesRouter,
  adminProspectCrmCohortsRouter,
)
