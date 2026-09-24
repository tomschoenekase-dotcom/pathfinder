/** Pure contract export; importing request validation never initializes a database client. */
import { z } from 'zod'
import {
  PROSPECT_GEOGRAPHY_HASH,
  ProspectPhysicalCountyEvidence,
} from './prospect-territory-registry'
export const AssignProspectGeographyInput = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(191),
    venueId: z.string().min(1).max(191),
    expectedVenueUpdatedAt: z.string().datetime(),
    expectedRevision: z.number().int().nonnegative(),
    expectedRegistryHash: z.literal(PROSPECT_GEOGRAPHY_HASH),
    evidence: ProspectPhysicalCountyEvidence,
  })
  .strict()
export const InvalidateProspectGeographyInput = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(191),
    venueId: z.string().min(1).max(191),
    expectedVenueUpdatedAt: z.string().datetime(),
    expectedRevision: z.number().int().positive(),
    expectedRegistryHash: z.literal(PROSPECT_GEOGRAPHY_HASH),
    reason: z.string().trim().min(12).max(2000),
  })
  .strict()
export const GeographyPageInput = z.object({
  page: z.number().int().min(1).max(100000).default(1),
  limit: z.number().int().min(1).max(100).default(25),
})
export const ResearchTerritorySearchInput = GeographyPageInput.extend({
  query: z.string().trim().max(200).optional(),
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  code: z.string().trim().min(1).max(100).optional(),
  corridor: z.boolean().optional(),
}).strict()
export const GeographyRecordSearchInput = GeographyPageInput.extend({
  query: z.string().trim().max(200).optional(),
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  legacyTerritoryId: z.string().min(1).max(191).optional(),
  territoryCode: z.string().min(1).max(100).optional(),
  countyGeoid: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  status: z.enum(['HELD', 'ASSIGNED', 'ALL']).default('HELD'),
}).strict()
/** A proposed source-backed assignment is not an approved canonical fact. */
export const ProposeProspectGeographyInput = AssignProspectGeographyInput.extend({
  researchClaim: z
    .object({ jobId: z.string().min(1).max(191), claimToken: z.string().uuid() })
    .strict()
    .optional(),
}).strict()
export const GeographyProposalListInput = z
  .object({
    venueId: z.string().min(1).max(191),
    status: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
    page: z.number().int().min(1).max(100000).default(1),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()
export const ResolveProspectGeographyProposalInput = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(191),
    reviewId: z.string().min(1).max(191),
    expectedReviewRevision: z.number().int().positive(),
    expectedRegistryHash: z.literal(PROSPECT_GEOGRAPHY_HASH),
    decision: z.enum(['ACCEPT', 'REJECT']),
    reason: z.string().trim().min(12).max(2000),
  })
  .strict()
export * from './prospect-territory-registry'
