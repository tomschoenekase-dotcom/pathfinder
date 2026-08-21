import { z } from 'zod'

export const CompanyKnowledgeType = z.enum([
  'DECISION',
  'STRATEGY',
  'MEETING_SUMMARY',
  'CLIENT_INSIGHT',
  'SALES_LESSON',
  'PRODUCT_RATIONALE',
  'TECHNICAL_LESSON',
  'POSTMORTEM',
  'POLICY_CONTEXT',
  'MARKET_RESEARCH',
  'COMPETITOR_INSIGHT',
  'COMPANY_HISTORY',
  'OPERATIONAL_LESSON',
  'OPEN_QUESTION',
  'PRIORITY',
  'COMMITMENT',
  'OTHER',
])
export type CompanyKnowledgeType = z.infer<typeof CompanyKnowledgeType>

export const CompanyKnowledgeAuthority = z.enum([
  'AUTHORITATIVE_CURRENT',
  'DURABLE_CONTEXT',
  'HISTORICAL',
  'INFERENCE',
  'SUPERSEDED',
])
export type CompanyKnowledgeAuthority = z.infer<typeof CompanyKnowledgeAuthority>

export const AccountContextRequest = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191).optional(),
    organizationId: z.string().trim().min(1).max(191).optional(),
    recentLimit: z.number().int().min(1).max(20).default(8),
  })
  .strict()
export type AccountContextRequest = z.input<typeof AccountContextRequest>

export const CompanyKnowledgeSearchRequest = z
  .object({
    query: z.string().trim().min(2).max(1000),
    clientId: z.string().trim().min(1).max(191).optional(),
    venueId: z.string().trim().min(1).max(191).optional(),
    organizationId: z.string().trim().min(1).max(191).optional(),
    types: z.array(CompanyKnowledgeType).max(CompanyKnowledgeType.options.length).default([]),
    authorities: z
      .array(CompanyKnowledgeAuthority)
      .max(CompanyKnowledgeAuthority.options.length)
      .default(['AUTHORITATIVE_CURRENT', 'DURABLE_CONTEXT']),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    includeHistorical: z.boolean().default(false),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict()
export type CompanyKnowledgeSearchRequest = z.input<typeof CompanyKnowledgeSearchRequest>

export const CompanyKnowledgeGetRequest = z
  .object({
    knowledgeItemId: z.string().trim().min(1).max(191),
    clientId: z.string().trim().min(1).max(191).optional(),
    venueId: z.string().trim().min(1).max(191).optional(),
  })
  .strict()
export type CompanyKnowledgeGetRequest = z.input<typeof CompanyKnowledgeGetRequest>

export const ACCOUNT_CONTEXT_COLLECTION_LIMITS = {
  contacts: 5,
  venues: 10,
  recentActivity: 12,
  milestones: 12,
  openLoops: 10,
  commitments: 10,
  relationshipNotes: 8,
} as const

export const ACCOUNT_CONTEXT_TARGET_BYTES = 16_384
export const KNOWLEDGE_SEARCH_TARGET_BYTES = 12_288
