import { z } from 'zod'

import { db, saveProspectOutreachDraftAction, withTenantIsolationBypass } from '@pathfinder/db'

export type ProspectAgentContext = Readonly<{
  actorId: string
  capabilities: readonly ('prospects:read' | 'prospects:draft')[]
}>

const searchInput = z
  .object({
    query: z.string().trim().max(200).optional(),
    stage: z
      .enum([
        'DISCOVERED',
        'RESEARCHED',
        'NEEDS_REVIEW',
        'READY_FOR_OUTREACH',
        'CONTACTED',
        'FOLLOW_UP_DUE',
        'REPLIED',
        'CONVERSATION',
        'QUALIFIED',
        'PROPOSAL_DECISION',
        'WON',
        'LOST',
        'PARKED',
        'DO_NOT_CONTACT',
      ])
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict()
const organizationInput = z.object({ organizationId: z.string().min(1).max(191) }).strict()
const campaignInput = z
  .object({
    campaignId: z.string().min(1).max(191),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()
const draftInput = z
  .object({
    memberId: z.string().min(1).max(191),
    subject: z.string().trim().min(1).max(998),
    textBody: z.string().trim().min(1).max(50_000),
    htmlBody: z.string().max(100_000).optional(),
    groundingSnapshot: z.record(z.unknown()),
  })
  .strict()

export const PROSPECT_AGENT_TOOL_DEFINITIONS = [
  { name: 'torchiko.prospects.search', capability: 'prospects:read', mutates: false },
  { name: 'torchiko.prospects.get_intelligence', capability: 'prospects:read', mutates: false },
  {
    name: 'torchiko.prospects.list_campaign_members',
    capability: 'prospects:read',
    mutates: false,
  },
  { name: 'torchiko.prospects.save_outreach_draft', capability: 'prospects:draft', mutates: true },
] as const

type ToolName = (typeof PROSPECT_AGENT_TOOL_DEFINITIONS)[number]['name']

export class ProspectAgentRegistryError extends Error {
  constructor(
    readonly code: 'UNKNOWN_TOOL' | 'CAPABILITY_REQUIRED' | 'INVALID_CONTEXT',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectAgentRegistryError'
  }
}

export type ProspectAgentRegistry = Readonly<{
  listTools: () => typeof PROSPECT_AGENT_TOOL_DEFINITIONS
  callTool: (name: string, input: unknown, context: ProspectAgentContext) => Promise<unknown>
}>

function authorize(name: ToolName, context: ProspectAgentContext) {
  if (!context.actorId || context.actorId.length > 191)
    throw new ProspectAgentRegistryError('INVALID_CONTEXT', 'Verified agent actor is required')
  const definition = PROSPECT_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name)!
  if (!context.capabilities.includes(definition.capability)) {
    throw new ProspectAgentRegistryError(
      'CAPABILITY_REQUIRED',
      `${definition.capability} capability is required`,
    )
  }
}

export function createProspectAgentRegistry(): ProspectAgentRegistry {
  return {
    listTools: () => PROSPECT_AGENT_TOOL_DEFINITIONS,
    async callTool(rawName, rawInput, context) {
      const definition = PROSPECT_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === rawName)
      if (!definition)
        throw new ProspectAgentRegistryError('UNKNOWN_TOOL', `Unknown tool: ${rawName}`)
      const name = definition.name
      authorize(name, context)
      return withTenantIsolationBypass(async () => {
        switch (name) {
          case 'torchiko.prospects.search': {
            const input = searchInput.parse(rawInput)
            return db.prospectOrganization.findMany({
              where: {
                archivedAt: null,
                ...(input.query
                  ? {
                      OR: [
                        { canonicalName: { contains: input.query, mode: 'insensitive' as const } },
                        {
                          venues: {
                            some: { name: { contains: input.query, mode: 'insensitive' as const } },
                          },
                        },
                        { normalizedDomain: { contains: input.query.toLowerCase() } },
                      ],
                    }
                  : {}),
                ...(input.stage ? { opportunity: { stage: input.stage } } : {}),
              },
              orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
              take: input.limit,
              select: {
                id: true,
                canonicalName: true,
                organizationType: true,
                relationshipTier: true,
                priority: true,
                territory: { select: { name: true } },
                opportunity: { select: { stage: true, nextAction: true, nextActionAt: true } },
                venues: {
                  where: { archivedAt: null },
                  take: 3,
                  select: { id: true, name: true, city: true, region: true },
                },
                contacts: {
                  where: { archivedAt: null },
                  take: 3,
                  select: {
                    id: true,
                    fullName: true,
                    title: true,
                    email: true,
                    doNotContact: true,
                  },
                },
              },
            })
          }
          case 'torchiko.prospects.get_intelligence': {
            const input = organizationInput.parse(rawInput)
            const prospect = await db.prospectOrganization.findUnique({
              where: { id: input.organizationId },
              include: {
                venues: { where: { archivedAt: null } },
                contacts: { where: { archivedAt: null } },
                sources: true,
                opportunity: true,
                activities: { orderBy: { occurredAt: 'desc' }, take: 100 },
                conversion: true,
              },
            })
            if (!prospect) return null
            if (!prospect.conversion?.venueId) return { prospect, liveVenue: null }
            const scope = {
              tenantId: prospect.conversion.tenantId,
              venueId: prospect.conversion.venueId,
            }
            const [venue, places, knowledge] = await Promise.all([
              db.venue.findFirst({
                where: { id: scope.venueId, tenantId: scope.tenantId },
                select: { id: true, name: true, category: true, isActive: true, updatedAt: true },
              }),
              db.place.findMany({
                where: { ...scope, isActive: true },
                take: 100,
                orderBy: { importanceScore: 'desc' },
                select: {
                  id: true,
                  name: true,
                  type: true,
                  shortDescription: true,
                  areaName: true,
                  tags: true,
                  updatedAt: true,
                },
              }),
              db.venueKnowledgeEntry.findMany({
                where: { ...scope, isEnabled: true },
                take: 100,
                orderBy: { updatedAt: 'desc' },
                select: {
                  id: true,
                  title: true,
                  category: true,
                  content: true,
                  humanConfirmedAt: true,
                  updatedAt: true,
                },
              }),
            ])
            return { prospect, liveVenue: venue ? { ...venue, places, knowledge } : null }
          }
          case 'torchiko.prospects.list_campaign_members': {
            const input = campaignInput.parse(rawInput)
            return db.prospectCampaignMember.findMany({
              where: { campaignId: input.campaignId },
              orderBy: { createdAt: 'asc' },
              take: input.limit,
              include: {
                organization: true,
                venue: true,
                contact: true,
                drafts: { orderBy: { version: 'desc' }, take: 1 },
              },
            })
          }
          case 'torchiko.prospects.save_outreach_draft': {
            const input = draftInput.parse(rawInput)
            return saveProspectOutreachDraftAction({
              memberId: input.memberId,
              subject: input.subject,
              textBody: input.textBody,
              groundingSnapshot: input.groundingSnapshot,
              ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
              actor: { type: 'AGENT', id: context.actorId, capabilities: context.capabilities },
            })
          }
        }
      })
    },
  }
}
