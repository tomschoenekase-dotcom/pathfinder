import { z } from 'zod'

import {
  askAgentQuestionAction,
  claimNextProspectResearchJobAction,
  db,
  finishProspectResearchJobAction,
  saveProspectOutreachDraftAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

const prospectCapability = z.enum([
  'prospects.read',
  'prospects.research',
  'prospects.draft',
  'prospects.question',
])
const prospectScope = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ALL') }).strict(),
  z
    .object({
      mode: z.literal('TERRITORIES'),
      territoryIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
    })
    .strict(),
])

export type VerifiedProspectAgentContext = Readonly<{
  tenantId: string
  venueId: string
  agentRunId: string
  actorId: string
  initiatorId: string
  capabilities: readonly z.infer<typeof prospectCapability>[]
  scope: z.infer<typeof prospectScope>
  modelProvider: string | null
  modelName: string | null
  promptIdentity: string
  requestedOperation: string
  correlationId: string
}>

export type ProspectAgentInvocation = Readonly<{
  tenantId: string
  venueId: string
  sessionId: string
  agentRunId: string
  leaseToken: string
  credentialId: string
  correlationId: string
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
const evidenceReference = z
  .object({
    kind: z.enum(['CRM_FIELD', 'SOURCE_EVIDENCE', 'WEBSITE_RESEARCH', 'CORRESPONDENCE']),
    reference: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
const draftInput = z
  .object({
    memberId: z.string().min(1).max(191),
    subject: z.string().trim().min(1).max(998),
    textBody: z.string().trim().min(1).max(50_000),
    htmlBody: z.string().max(100_000).optional(),
    evidence: z.array(evidenceReference).min(1).max(50),
    template: z
      .object({ id: z.string().trim().min(1).max(191), version: z.string().trim().min(1).max(100) })
      .strict(),
    prompt: z
      .object({ id: z.string().trim().min(1).max(191), version: z.string().trim().min(1).max(100) })
      .strict(),
    warnings: z.array(z.string().trim().min(1).max(500)).max(25).default([]),
  })
  .strict()
const questionInput = z
  .object({
    operationId: z.string().uuid(),
    question: z.string().trim().min(1).max(2_000),
    context: z.string().trim().min(1).max(2_000).optional(),
    urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
    blocking: z.boolean().default(true),
    evidence: z.array(evidenceReference).max(20).default([]),
  })
  .strict()
const claimResearchInput = z
  .object({ leaseSeconds: z.number().int().min(60).max(1_800).default(900) })
  .strict()
const finishResearchInput = z
  .object({
    claimToken: z.string().uuid(),
    outcome: z.enum(['RESEARCHED', 'NEEDS_REVIEW', 'BLOCKED', 'CAP_REACHED', 'SKIPPED']),
    reason: z.string().trim().min(1).max(2_000),
    usage: z.record(z.unknown()).default({}),
    costUsd: z.number().min(0).max(10_000).optional(),
  })
  .strict()
const releaseResearchInput = z
  .object({ claimToken: z.string().uuid(), reason: z.string().trim().min(1).max(2_000) })
  .strict()

export const PROSPECT_AGENT_TOOL_DEFINITIONS = [
  {
    name: 'torchiko.prospects.search',
    title: 'Search prospects',
    description: 'Search bounded prospect organizations inside the frozen run scope.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    name: 'torchiko.prospects.get_intelligence',
    title: 'Get prospect intelligence',
    description: 'Read grounded CRM and linked live-venue intelligence for one prospect.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    name: 'torchiko.prospects.list_campaign_members',
    title: 'List campaign members',
    description: 'List bounded campaign membership inside the frozen prospect scope.',
    capability: 'prospects.read',
    effect: 'read',
    mutates: false,
    idempotent: true,
    humanReviewRequired: false,
  },
  {
    name: 'torchiko.prospects.claim_research_job',
    title: 'Claim next prospect research job',
    description: 'Claim one unfinished in-scope prospect under a bounded durable lease.',
    capability: 'prospects.research',
    effect: 'execute',
    mutates: true,
    idempotent: false,
    humanReviewRequired: false,
  },
  {
    name: 'torchiko.prospects.complete_research_job',
    title: 'Complete prospect research job',
    description: 'Record a bounded research outcome, usage, cost, and exact attempt lineage.',
    capability: 'prospects.research',
    effect: 'execute',
    mutates: true,
    idempotent: false,
    humanReviewRequired: false,
  },
  {
    name: 'torchiko.prospects.release_research_job',
    title: 'Release prospect research job',
    description: 'Release an unfinished claim back to the queue without changing prospect facts.',
    capability: 'prospects.research',
    effect: 'execute',
    mutates: true,
    idempotent: false,
    humanReviewRequired: false,
  },
  {
    name: 'torchiko.prospects.save_outreach_draft',
    title: 'Save outreach draft',
    description: 'Save a grounded, versioned outreach draft that cannot be sent or approved.',
    capability: 'prospects.draft',
    effect: 'draft',
    mutates: true,
    idempotent: false,
    humanReviewRequired: true,
  },
  {
    name: 'torchiko.prospects.ask_operator',
    title: 'Ask prospect operator',
    description: 'Create or replay a durable scoped question without granting approval.',
    capability: 'prospects.question',
    effect: 'interaction',
    mutates: true,
    idempotent: true,
    humanReviewRequired: false,
  },
] as const

type ToolName = (typeof PROSPECT_AGENT_TOOL_DEFINITIONS)[number]['name']

export class ProspectAgentRegistryError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_TOOL'
      | 'CAPABILITY_REQUIRED'
      | 'INVALID_CONTEXT'
      | 'SCOPE_REQUIRED'
      | 'OUT_OF_SCOPE',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectAgentRegistryError'
  }
}

export type ProspectAgentRegistry = Readonly<{
  listTools: () => typeof PROSPECT_AGENT_TOOL_DEFINITIONS
  callTool: (name: string, input: unknown, invocation: ProspectAgentInvocation) => Promise<unknown>
}>

type Resolver = (invocation: ProspectAgentInvocation) => Promise<VerifiedProspectAgentContext>

const frozenScopeSchema = z
  .object({
    accessCapabilities: z.array(z.string()),
    prospectScope,
    promptIdentity: z.string().trim().min(1).max(191),
  })
  .passthrough()

/** Resolve authority from the authenticated bridge's live, leased AgentRun. Caller-supplied
 * identities, capability arrays, or prospect scopes are never accepted as authority. */
export async function resolveVerifiedProspectAgentContext(
  invocation: ProspectAgentInvocation,
): Promise<VerifiedProspectAgentContext> {
  const parsed = z
    .object({
      tenantId: z.string().trim().min(1).max(191),
      venueId: z.string().trim().min(1).max(191),
      sessionId: z.string().uuid(),
      agentRunId: z.string().trim().min(1).max(191),
      leaseToken: z.string().uuid(),
      credentialId: z.string().trim().min(1).max(191),
      correlationId: z.string().uuid(),
    })
    .strict()
    .parse(invocation)
  const now = new Date()
  const run = await db.agentRun.findFirst({
    where: {
      id: parsed.agentRunId,
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      status: 'RUNNING',
      executionLeaseToken: parsed.leaseToken,
      executionLeaseExpiresAt: { gt: now },
      executionBridgeSessionId: parsed.sessionId,
      executionBridgeSession: {
        credentialId: parsed.credentialId,
        status: 'ONLINE',
        expiresAt: { gt: now },
      },
      agentIdentity: { enabled: true },
    },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      initiatedById: true,
      requestedOperation: true,
      scopeSnapshot: true,
      modelProvider: true,
      modelName: true,
      agentIdentity: { select: { id: true, accessCapabilities: true } },
    },
  })
  if (!run || !run.venueId) {
    throw new ProspectAgentRegistryError(
      'INVALID_CONTEXT',
      'A live bridge-owned AgentRun is required',
    )
  }
  const frozen = frozenScopeSchema.safeParse(run.scopeSnapshot)
  if (!frozen.success) {
    throw new ProspectAgentRegistryError(
      'SCOPE_REQUIRED',
      'AgentRun has no explicit frozen prospect scope',
    )
  }
  const live = new Set(run.agentIdentity.accessCapabilities)
  const capabilities = frozen.data.accessCapabilities
    .filter(
      (capability): capability is z.infer<typeof prospectCapability> =>
        prospectCapability.safeParse(capability).success,
    )
    .filter((capability) => live.has(capability))
  return {
    tenantId: run.tenantId,
    venueId: run.venueId,
    agentRunId: run.id,
    actorId: run.agentIdentity.id,
    initiatorId: run.initiatedById,
    capabilities,
    scope: frozen.data.prospectScope,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    promptIdentity: frozen.data.promptIdentity,
    requestedOperation: run.requestedOperation,
    correlationId: parsed.correlationId,
  }
}

function authorize(name: ToolName, context: VerifiedProspectAgentContext) {
  const definition = PROSPECT_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name)!
  if (!context.capabilities.includes(definition.capability)) {
    throw new ProspectAgentRegistryError(
      'CAPABILITY_REQUIRED',
      `${definition.capability} capability is required by both the live identity and frozen run`,
    )
  }
}

function organizationScope(context: VerifiedProspectAgentContext) {
  return context.scope.mode === 'ALL'
    ? {}
    : { territoryId: { in: [...new Set(context.scope.territoryIds)] } }
}

export function createProspectAgentRegistry(
  dependencies: Readonly<{ resolveContext?: Resolver }> = {},
): ProspectAgentRegistry {
  const resolveContext = dependencies.resolveContext ?? resolveVerifiedProspectAgentContext
  return {
    listTools: () => PROSPECT_AGENT_TOOL_DEFINITIONS,
    async callTool(rawName, rawInput, invocation) {
      const definition = PROSPECT_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === rawName)
      if (!definition)
        throw new ProspectAgentRegistryError('UNKNOWN_TOOL', `Unknown tool: ${rawName}`)
      const name = definition.name
      const context = await resolveContext(invocation)
      authorize(name, context)
      return withTenantIsolationBypass(async () => {
        switch (name) {
          case 'torchiko.prospects.search': {
            const input = searchInput.parse(rawInput)
            return db.prospectOrganization.findMany({
              where: {
                ...organizationScope(context),
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
            const prospect = await db.prospectOrganization.findFirst({
              where: { id: input.organizationId, ...organizationScope(context) },
              include: {
                venues: { where: { archivedAt: null } },
                contacts: { where: { archivedAt: null } },
                sources: true,
                opportunity: true,
                activities: { orderBy: { occurredAt: 'desc' }, take: 100 },
                customerRelationships: {
                  where: { status: 'ACTIVE', tenantId: context.tenantId },
                  take: 5,
                  include: {
                    locationConversions: {
                      where: { status: 'ACTIVE' },
                      take: 20,
                      orderBy: { convertedAt: 'desc' },
                    },
                  },
                },
              },
            })
            if (!prospect) return null
            const location = prospect.customerRelationships[0]?.locationConversions[0]
            if (!location) return { prospect, liveVenue: null }
            const scope = {
              tenantId: context.tenantId,
              venueId: location.venueId,
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
              where: { campaignId: input.campaignId, organization: organizationScope(context) },
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
          case 'torchiko.prospects.claim_research_job': {
            const input = claimResearchInput.parse(rawInput)
            return claimNextProspectResearchJobAction({
              leaseSeconds: input.leaseSeconds,
              context: {
                agentRunId: context.agentRunId,
                agentIdentityId: context.actorId,
                ...(context.scope.mode === 'TERRITORIES'
                  ? { territoryIds: context.scope.territoryIds }
                  : {}),
                modelProvider: context.modelProvider,
                modelName: context.modelName,
                promptIdentity: context.promptIdentity,
              },
            })
          }
          case 'torchiko.prospects.complete_research_job': {
            const input = finishResearchInput.parse(rawInput)
            return finishProspectResearchJobAction({
              claimToken: input.claimToken,
              outcome: input.outcome,
              reason: input.reason,
              usage: input.usage,
              ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
              context: {
                agentRunId: context.agentRunId,
                agentIdentityId: context.actorId,
                modelProvider: context.modelProvider,
                modelName: context.modelName,
                promptIdentity: context.promptIdentity,
              },
            })
          }
          case 'torchiko.prospects.release_research_job': {
            const input = releaseResearchInput.parse(rawInput)
            return finishProspectResearchJobAction({
              ...input,
              outcome: 'RELEASED',
              context: {
                agentRunId: context.agentRunId,
                agentIdentityId: context.actorId,
                modelProvider: context.modelProvider,
                modelName: context.modelName,
                promptIdentity: context.promptIdentity,
              },
            })
          }
          case 'torchiko.prospects.save_outreach_draft': {
            const input = draftInput.parse(rawInput)
            const member = await db.prospectCampaignMember.findFirst({
              where: { id: input.memberId, organization: organizationScope(context) },
              select: { id: true },
            })
            if (!member)
              throw new ProspectAgentRegistryError(
                'OUT_OF_SCOPE',
                'Campaign member is out of scope',
              )
            return saveProspectOutreachDraftAction({
              memberId: input.memberId,
              subject: input.subject,
              textBody: input.textBody,
              groundingSnapshot: {
                schemaVersion: 1,
                evidence: input.evidence.map((item) => ({
                  ...item,
                  trust:
                    item.kind === 'CRM_FIELD'
                      ? 'CANONICAL_CRM_DATA'
                      : 'UNTRUSTED_EXTERNAL_EVIDENCE',
                })),
                template: input.template,
                prompt: input.prompt,
                warnings: input.warnings,
                lineage: {
                  agentRunId: context.agentRunId,
                  agentIdentityId: context.actorId,
                  initiatorId: context.initiatorId,
                  modelProvider: context.modelProvider,
                  modelName: context.modelName,
                  runPromptIdentity: context.promptIdentity,
                  correlationId: context.correlationId,
                },
              },
              ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
              // The domain action retains its compatibility capability spelling. The registry
              // is the server-authoritative boundary and has already verified the AgentRun.
              actor: { type: 'AGENT', id: context.actorId, capabilities: ['prospects:draft'] },
            })
          }
          case 'torchiko.prospects.ask_operator': {
            const input = questionInput.parse(rawInput)
            return askAgentQuestionAction({
              operationId: input.operationId,
              tenantId: context.tenantId,
              venueId: context.venueId,
              agentIdentityId: context.actorId,
              agentRunId: context.agentRunId,
              question: input.question,
              ...(input.context ? { context: input.context } : {}),
              category: 'prospect-crm',
              urgency: input.urgency,
              blocking: input.blocking,
              evidence: input.evidence.map((item) => ({
                label: item.kind,
                reference: item.reference,
                ...(item.summary ? { summary: item.summary } : {}),
              })),
              callbackMetadata: { correlationId: context.correlationId },
            })
          }
        }
      })
    },
  }
}
