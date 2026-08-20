import { mergeRouters } from '../../core'
import { adminProspectCrmCoreRouter } from './prospect-crm-core'
import { adminProspectCrmDuplicatesRouter } from './prospect-crm-duplicates'
import { adminProspectCrmImportRouter } from './prospect-crm-import'
import { adminProspectCrmOutreachRouter } from './prospect-crm-outreach'

export const adminProspectCrmRouter = mergeRouters(
  adminProspectCrmCoreRouter,
  adminProspectCrmImportRouter,
  adminProspectCrmDuplicatesRouter,
  adminProspectCrmOutreachRouter,
)
