import { z } from 'zod'
import { PROSPECT_GEOGRAPHY_HASH, GeographyPublicUrl, ProspectPhysicalCountyEvidence } from './prospect-territory-registry'

const key=z.string().trim().min(1).max(191)
const county=z.string().regex(/^\d{5}$/)
const base=z.object({idempotencyKey:key,expectedRegistryHash:z.literal(PROSPECT_GEOGRAPHY_HASH),countyGeoid:county})
export const CountyResearchCell=z.object({id:key,locality:z.string().trim().min(1).max(200),category:z.string().trim().min(1).max(200),question:z.string().trim().min(12).max(1000)}).strict()
export const ClaimCountyResearchInput=base.extend({
  scopeKind:z.literal('WHOLE_COUNTY'),leaseSeconds:z.number().int().min(60).max(1800).default(900),
  plannedCells:z.array(CountyResearchCell).min(1).max(100).refine(v=>new Set(v.map(c=>c.id)).size===v.length,'Cell IDs must be unique'),
}).strict()
const held=base.extend({claimToken:z.string().uuid(),generation:z.number().int().positive()})
export const RenewCountyResearchInput=held.extend({leaseSeconds:z.number().int().min(60).max(1800).default(900)}).strict()
export const ReleaseCountyResearchInput=held.extend({reason:z.string().trim().min(12).max(2000)}).strict()
export const CompleteCountyResearchInput=held.extend({
  summary:z.string().trim().min(12).max(2000),
  cells:z.array(z.object({id:key,status:z.enum(['NOT_ATTEMPTED','PARTIAL','SEARCHED_NO_RESULTS','SEARCHED_WITH_RESULTS']),
    sourceUrls:z.array(GeographyPublicUrl).max(30),queries:z.array(z.string().trim().min(1).max(500)).max(30),
    findingReceiptIds:z.array(key).max(100),note:z.string().trim().min(12).max(2000),
  }).strict()).max(100),
}).strict()
export const ReadCountyResearchInput=z.object({countyGeoid:county.optional(),page:z.number().int().min(1).max(100000).default(1),limit:z.number().int().min(1).max(100).default(25)}).strict()
export const CountyDiscoveryCandidate=z.object({
  name:z.string().trim().min(2).max(300),aliases:z.array(z.string().trim().min(2).max(300)).max(10).default([]),
  website:GeographyPublicUrl,websiteQuote:z.string().trim().min(12).max(2000),
  category:z.string().trim().min(2).max(200),categoryQuote:z.string().trim().min(12).max(2000),
  address:z.object({line1:z.string().trim().min(5).max(500),line2:z.string().trim().max(200).optional(),city:z.string().trim().min(2).max(200),postalCode:z.string().regex(/^\d{5}(-\d{4})?$/).optional()}).strict(),
  physicalEvidence:ProspectPhysicalCountyEvidence.omit({venueId:true}),
  publicContactRoutes:z.array(z.object({kind:z.enum(['EMAIL','FORM','PHONE']),value:z.string().trim().min(3).max(1000),
    sourceUrl:GeographyPublicUrl,quote:z.string().trim().min(12).max(2000)}).strict()).max(10).default([]),
}).strict()
export const SubmitCountyDiscoveryInput=held.extend({cellId:key,candidate:CountyDiscoveryCandidate}).strict()
export const ReadCountyDiscoveryInput=z.object({reviewId:key.optional(),countyGeoid:county.optional(),status:z.enum(['OPEN','RESOLVED','ALL']).default('OPEN'),page:z.number().int().min(1).max(100000).default(1),limit:z.number().int().min(1).max(50).default(20)}).strict()
export const DecideCountyDiscoveryInput=z.object({idempotencyKey:key,expectedRegistryHash:z.literal(PROSPECT_GEOGRAPHY_HASH),reviewId:key,expectedRevision:z.number().int().positive(),
  decision:z.enum(['REJECT','LINK_EXISTING','CREATE_DISTINCT']),reason:z.string().trim().min(30).max(2000),
  observationReceiptId:key,existingVenueId:key.optional(),organizationId:key.optional(),
  acknowledgedIdentityMatchIds:z.array(key).max(100).default([]),
}).strict()
