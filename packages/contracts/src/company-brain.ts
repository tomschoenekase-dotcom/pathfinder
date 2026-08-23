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

const FounderDecisionScopeValue = z.union([
  z.string().max(1000),
  z.number().finite(),
  z.boolean(),
  z.null(),
])

export const FounderDecisionPacketDecision = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    title: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(4000),
    decision: z.string().trim().min(1).max(20_000),
    rationale: z.string().trim().min(1).max(10_000),
    affectedSystems: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    scope: z.record(z.string().trim().min(1).max(100), FounderDecisionScopeValue).default({}),
  })
  .strict()

export const FounderDecisionPacket = z
  .object({
    schemaVersion: z.literal('founder-decision-packet.v1'),
    packetId: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    title: z.string().trim().min(1).max(500),
    effectiveAt: z.string().datetime({ offset: true }),
    sourceRef: z.string().trim().min(1).max(1000),
    decisions: z.array(FounderDecisionPacketDecision).min(1).max(50),
  })
  .strict()
  .superRefine((packet, context) => {
    const keys = new Set<string>()
    packet.decisions.forEach((decision, index) => {
      if (keys.has(decision.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['decisions', index, 'key'],
          message: 'Decision keys must be unique within a packet',
        })
      }
      keys.add(decision.key)
    })
  })

export type FounderDecisionPacket = z.input<typeof FounderDecisionPacket>

export const AccountContextRequest = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191).optional(),
    organizationId: z.string().trim().min(1).max(191).optional(),
    recentLimit: z.number().int().min(1).max(20).default(8),
  })
  .strict()
export type AccountContextRequest = z.input<typeof AccountContextRequest>

export const AccountHistoryRequest = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191).optional(),
    organizationId: z.string().trim().min(1).max(191).optional(),
    before: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()
export type AccountHistoryRequest = z.input<typeof AccountHistoryRequest>

export const AccountMeetingGetRequest = z
  .object({
    clientId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191).optional(),
    meetingId: z.string().trim().min(1).max(191),
  })
  .strict()
export type AccountMeetingGetRequest = z.input<typeof AccountMeetingGetRequest>

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
