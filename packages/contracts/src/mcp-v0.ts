import { z } from 'zod'

import { VenueLocationDraftFieldsSchema } from './location-authoring'

/** Contract-only MCP catalog. It does not provide a transport, authentication, or data access. */
export const PATHFINDER_MCP_PROTOCOL_VERSION = '2026-07-28' as const
export const PATHFINDER_MCP_CATALOG_VERSION = 'pathfinder-mcp-v0' as const

const Identifier = z.string().trim().min(1).max(120)
const Summary = z.string().trim().min(1).max(2_000)
const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValue),
    z.record(JsonValue),
  ]),
)

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export const McpCapability = z.enum([
  'resources:read',
  'clients:read',
  'billing:read',
  'billing:propose',
  'venues:read',
  'configuration:read',
  'content:read',
  'history:read',
  'packages:read',
  'support:read',
  'updates:read',
  'ai-usage:read',
  'jobs:read',
  'evaluations:read',
  'reports:read',
  'reports:draft',
  'conversations:read',
  'conversations:review',
  'customer-access:prepare',
  'integrations:read',
  'agent-runs:read',
  'events:read',
  'deployments:read',
  'feature-flags:read',
  'readiness:read',
  'questions:read',
  'outcomes:read',
  'agent-improvements:read',
  'agent-improvements:propose',
  'agent-improvements:validate',
  'accounts:read',
  'knowledge:read',
  'knowledge:draft',
  'locations:propose',
  'meetings:read',
  'meetings:process',
  'workers:read',
  'questions:ask',
  'delegations:create',
  'agent-runs:execute',
  'packages:draft',
  'support:draft',
  'intake:draft',
  'updates:draft',
  'evaluations:request',
])
export type McpCapability = z.infer<typeof McpCapability>

export const McpScopeLevel = z.enum(['client', 'venue', 'client-or-venue'])
export type McpScopeLevel = z.infer<typeof McpScopeLevel>

/** Must be constructed from a server-verified credential, never tool arguments. */
export const VerifiedMcpCredentialScope = z
  .object({
    credentialId: Identifier,
    tenantId: Identifier,
    clientId: Identifier,
    venueIds: z.array(Identifier).max(500),
    capabilities: z.array(McpCapability).max(McpCapability.options.length),
  })
  .strict()
  .superRefine((scope, context) => {
    if (new Set(scope.venueIds).size !== scope.venueIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['venueIds'],
        message: 'Venue scope must be unique',
      })
    }
    if (new Set(scope.capabilities).size !== scope.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message: 'Capabilities must be unique',
      })
    }
  })
export type VerifiedMcpCredentialScope = z.infer<typeof VerifiedMcpCredentialScope>

export const McpRequestedScope = z
  .object({ clientId: Identifier, venueId: Identifier.optional() })
  .strict()
export type McpRequestedScope = z.infer<typeof McpRequestedScope>

export class McpScopeError extends Error {
  readonly code = 'MCP_SCOPE_DENIED'
}

export function assertMcpScope(
  rawCredential: VerifiedMcpCredentialScope,
  rawRequest: McpRequestedScope,
  capability: McpCapability,
  level: McpScopeLevel,
): void {
  const credential = VerifiedMcpCredentialScope.parse(rawCredential)
  const request = McpRequestedScope.parse({
    clientId: rawRequest.clientId,
    ...(rawRequest.venueId !== undefined ? { venueId: rawRequest.venueId } : {}),
  })
  if (request.clientId !== credential.clientId) throw new McpScopeError('Client scope denied')
  if (!credential.capabilities.includes(capability)) throw new McpScopeError('Capability denied')
  if (level === 'venue') {
    if (!request.venueId) throw new McpScopeError('Venue scope is required')
    if (!credential.venueIds.includes(request.venueId))
      throw new McpScopeError('Venue scope denied')
  }
}

export type JsonSchema = Readonly<Record<string, unknown>>

export type PathfinderMcpSecurityMetadata = Readonly<{
  scope: McpScopeLevel
  capability: McpCapability
  tenantBound: true
  clientBound: true
  venueBound: boolean | 'conditional'
  risk: 'low' | 'moderate'
  effect: 'read' | 'interaction' | 'draft' | 'bounded-evaluation-request'
  defaultEnabled: boolean
  approvalRequired: boolean
}>

export type PathfinderMcpResourceDefinition = Readonly<{
  name: string
  title: string
  description: string
  uriTemplate: string
  mimeType: 'application/json'
  annotations: Readonly<{ audience: readonly ['assistant']; priority: number }>
  _meta: Readonly<{ 'com.pathfinder/security': PathfinderMcpSecurityMetadata }>
}>

export type PathfinderMcpToolDefinition = Readonly<{
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  annotations: Readonly<{
    readOnlyHint: boolean
    destructiveHint: false
    idempotentHint: boolean
    openWorldHint: false
  }>
  _meta: Readonly<{ 'com.pathfinder/security': PathfinderMcpSecurityMetadata }>
}>

function security(
  scope: McpScopeLevel,
  capability: McpCapability,
  effect: PathfinderMcpSecurityMetadata['effect'],
): PathfinderMcpSecurityMetadata {
  const readOnly = effect === 'read'
  const approvalRequired = effect === 'draft' || effect === 'bounded-evaluation-request'
  return {
    scope,
    capability,
    tenantBound: true,
    clientBound: true,
    venueBound: scope === 'client-or-venue' ? 'conditional' : scope === 'venue',
    risk: readOnly || effect === 'interaction' ? 'low' : 'moderate',
    effect,
    defaultEnabled: !approvalRequired,
    approvalRequired,
  }
}

type ResourceSeed = readonly [string, string, string, string, McpScopeLevel, McpCapability]
const resourceSeeds: readonly ResourceSeed[] = [
  [
    'clients',
    'Clients',
    'Client account identity and lifecycle state.',
    'pathfinder://clients/{clientId}',
    'client',
    'clients:read',
  ],
  [
    'billing',
    'Billing',
    'Client-scoped commercial arrangement, paid-through, invoice, and reconciliation projections.',
    'pathfinder://clients/{clientId}/billing',
    'client',
    'billing:read',
  ],
  [
    'venues',
    'Venues',
    'Venues belonging to an authorized client.',
    'pathfinder://clients/{clientId}/venues/{venueId}',
    'venue',
    'venues:read',
  ],
  [
    'configuration',
    'Venue configuration',
    'Resolved venue configuration with provenance.',
    'pathfinder://clients/{clientId}/venues/{venueId}/configuration',
    'venue',
    'configuration:read',
  ],
  [
    'content',
    'Venue content',
    'Venue-scoped places and knowledge content.',
    'pathfinder://clients/{clientId}/venues/{venueId}/content',
    'venue',
    'content:read',
  ],
  [
    'history',
    'Content history',
    'Reviewable venue content version history.',
    'pathfinder://clients/{clientId}/venues/{venueId}/history',
    'venue',
    'history:read',
  ],
  [
    'packages',
    'Venue packages',
    'Venue package drafts, validation state, and history.',
    'pathfinder://clients/{clientId}/venues/{venueId}/packages',
    'venue',
    'packages:read',
  ],
  [
    'support',
    'Support requests',
    'Venue support requests and authorized conversation state.',
    'pathfinder://clients/{clientId}/venues/{venueId}/support',
    'venue',
    'support:read',
  ],
  [
    'updates',
    'Operational updates',
    'Scheduled, active, and historical venue updates.',
    'pathfinder://clients/{clientId}/venues/{venueId}/updates',
    'venue',
    'updates:read',
  ],
  [
    'ai-usage',
    'AI usage',
    'Bounded venue AI cost, token, latency, and configured tenant hard-budget state without operator policy material or mutation authority.',
    'pathfinder://clients/{clientId}/venues/{venueId}/ai-usage',
    'venue',
    'ai-usage:read',
  ],
  [
    'jobs',
    'Jobs',
    'Venue-scoped persisted background-job status, failure pressure, and shared worker-heartbeat evidence with explicit live-queue and execution-proof boundaries.',
    'pathfinder://clients/{clientId}/venues/{venueId}/jobs',
    'venue',
    'jobs:read',
  ],
  [
    'evaluations',
    'Evaluations',
    'Venue evaluation runs and scored results.',
    'pathfinder://clients/{clientId}/venues/{venueId}/evaluations',
    'venue',
    'evaluations:read',
  ],
  [
    'reports',
    'Weekly reports',
    'Venue report lifecycle, volume, and publication metadata without report content or errors.',
    'pathfinder://clients/{clientId}/venues/{venueId}/reports',
    'venue',
    'reports:read',
  ],
  [
    'conversations',
    'Conversations',
    'Privacy-bounded visitor conversation session metadata without visitor identifiers, coordinates, or message content.',
    'pathfinder://clients/{clientId}/venues/{venueId}/conversations',
    'venue',
    'conversations:read',
  ],
  [
    'integrations',
    'Integration access',
    'Venue-scoped external access configuration and last-use health metadata without secret material.',
    'pathfinder://clients/{clientId}/venues/{venueId}/integrations',
    'venue',
    'integrations:read',
  ],
  [
    'agent-runs',
    'Agent runs',
    'Venue-scoped run status, model, attempt, cost, and lineage metadata without prompts or artifacts.',
    'pathfinder://clients/{clientId}/venues/{venueId}/agent-runs',
    'venue',
    'agent-runs:read',
  ],
  [
    'agent-run-trace',
    'Agent run trace',
    'One bounded run chronology over safe action, lifecycle, approval, and outcome evidence without raw payloads, scope snapshots, or execution leases.',
    'pathfinder://clients/{clientId}/venues/{venueId}/agent-runs/{agentRunId}/trace',
    'venue',
    'agent-runs:read',
  ],
  [
    'events',
    'Operational events',
    'Venue-scoped operational attention events and recovery guidance.',
    'pathfinder://clients/{clientId}/venues/{venueId}/events',
    'venue',
    'events:read',
  ],
  [
    'deployments',
    'Venue deployments',
    'Native venue deployment lifecycle metadata without plans, state snapshots, or hashes.',
    'pathfinder://clients/{clientId}/venues/{venueId}/deployments',
    'venue',
    'deployments:read',
  ],
  [
    'feature-flags',
    'Feature flags',
    'Client-scoped feature-flag state without internal metadata or actor identities.',
    'pathfinder://clients/{clientId}/feature-flags',
    'client',
    'feature-flags:read',
  ],
  [
    'onboarding-summary',
    'Onboarding summary',
    'Versioned venue onboarding readiness and bounded milestone rollup.',
    'pathfinder://clients/{clientId}/venues/{venueId}/onboarding-summary',
    'venue',
    'readiness:read',
  ],
  [
    'readiness',
    'Venue readiness',
    'Onboarding, preview, launch-readiness, native-head convergence, and secret-free native guest-read preflight evidence.',
    'pathfinder://clients/{clientId}/venues/{venueId}/readiness',
    'venue',
    'readiness:read',
  ],
  [
    'questions',
    'Agent questions',
    'Pending and resolved operator clarifications raised by venue-scoped agents.',
    'pathfinder://clients/{clientId}/venues/{venueId}/agent-questions',
    'venue',
    'questions:read',
  ],
  [
    'outcomes',
    'Agent outcomes',
    'Explicit outcome observations for venue-scoped agent work.',
    'pathfinder://clients/{clientId}/venues/{venueId}/agent-outcomes',
    'venue',
    'outcomes:read',
  ],
  [
    'agent-improvements',
    'Agent improvement proposals',
    'Versioned, evidence-backed agent improvement proposals and human review state.',
    'pathfinder://clients/{clientId}/venues/{venueId}/agent-improvements',
    'venue',
    'agent-improvements:read',
  ],
]

export const McpResourceKind = z.enum(resourceSeeds.map(([name]) => name) as [string, ...string[]])
export type McpResourceKind = z.infer<typeof McpResourceKind>
export const MCP_RESOURCE_SECURITY_BY_KIND = Object.fromEntries(
  resourceSeeds.map(([name, , , , scope, capability]) => [name, { scope, capability }]),
) as Readonly<
  Record<McpResourceKind, Readonly<{ scope: McpScopeLevel; capability: McpCapability }>>
>

export const PATHFINDER_MCP_RESOURCES: readonly PathfinderMcpResourceDefinition[] =
  resourceSeeds.map(([name, title, description, uriTemplate, scope, capability]) => ({
    name: `pathfinder.${name}`,
    title,
    description,
    uriTemplate,
    mimeType: 'application/json',
    annotations: { audience: ['assistant'], priority: 0.8 },
    _meta: { 'com.pathfinder/security': security(scope, capability, 'read') },
  }))

const scopeProperties = {
  clientId: { type: 'string', minLength: 1, maxLength: 120 },
  venueId: { type: 'string', minLength: 1, maxLength: 120 },
} as const
const scopeRequired = ['clientId', 'venueId'] as const
const strictObject = (
  properties: Record<string, unknown>,
  required: readonly string[],
): JsonSchema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const resultSchema = strictObject(
  {
    kind: { type: 'string', minLength: 1, maxLength: 80 },
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    data: {},
  },
  ['kind', 'summary', 'data'],
)

export const McpReadInput = McpRequestedScope.extend({
  resource: McpResourceKind,
  agentRunId: Identifier.optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).default(25),
})
  .strict()
  .superRefine((value, context) => {
    if (value.resource === 'agent-run-trace' && !value.agentRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'agentRunId is required for an agent run trace.',
      })
    }
    if (value.resource !== 'agent-run-trace' && value.agentRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'agentRunId is only accepted for an agent run trace.',
      })
    }
  })
export type McpReadInput = z.infer<typeof McpReadInput>

export const McpAccountContextInput = McpRequestedScope.extend({
  organizationId: Identifier.optional(),
  recentLimit: z.number().int().min(1).max(20).default(8),
}).strict()
export type McpAccountContextInput = z.infer<typeof McpAccountContextInput>

export const McpAccountHistoryInput = McpRequestedScope.extend({
  organizationId: Identifier.optional(),
  before: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict()
export type McpAccountHistoryInput = z.infer<typeof McpAccountHistoryInput>

export const McpAccountMeetingGetInput = McpRequestedScope.extend({
  meetingId: Identifier,
}).strict()
export type McpAccountMeetingGetInput = z.infer<typeof McpAccountMeetingGetInput>

export const McpIntegrationHealthInput = McpRequestedScope
export type McpIntegrationHealthInput = z.infer<typeof McpIntegrationHealthInput>

export const McpReportLifecycleInput = McpRequestedScope.extend({
  reportId: Identifier,
}).strict()
export type McpReportLifecycleInput = z.infer<typeof McpReportLifecycleInput>

const McpKnowledgeType = z.enum([
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
const McpKnowledgeAuthority = z.enum([
  'AUTHORITATIVE_CURRENT',
  'DURABLE_CONTEXT',
  'HISTORICAL',
  'INFERENCE',
  'SUPERSEDED',
])

export const McpKnowledgeSearchInput = McpRequestedScope.extend({
  query: z.string().trim().min(2).max(1000),
  organizationId: Identifier.optional(),
  types: z.array(McpKnowledgeType).max(McpKnowledgeType.options.length).default([]),
  authorities: z
    .array(McpKnowledgeAuthority)
    .max(McpKnowledgeAuthority.options.length)
    .default(['AUTHORITATIVE_CURRENT', 'DURABLE_CONTEXT']),
  includeHistorical: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(5),
}).strict()
export type McpKnowledgeSearchInput = z.infer<typeof McpKnowledgeSearchInput>

export const McpKnowledgeGetInput = McpRequestedScope.extend({
  knowledgeItemId: Identifier,
}).strict()
export type McpKnowledgeGetInput = z.infer<typeof McpKnowledgeGetInput>

export const McpKnowledgeGapListInput = McpRequestedScope.extend({
  limit: z.number().int().min(1).max(25).default(10),
}).strict()
export type McpKnowledgeGapListInput = z.infer<typeof McpKnowledgeGapListInput>

export const McpKnowledgeCorrectionProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  conversationInsightId: z.string().uuid(),
  targetKnowledgeEntryId: Identifier.optional(),
  correctionKind: z.enum([
    'CREATE_KNOWLEDGE',
    'UPDATE_KNOWLEDGE',
    'RETIRE_KNOWLEDGE',
    'RETRIEVAL_CORRECTION',
    'NO_CONTENT_CHANGE',
  ]),
  aiInference: z.string().trim().min(1).max(2000),
  proposedChange: z.string().trim().min(1).max(10000),
  reason: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1),
}).strict()
export type McpKnowledgeCorrectionProposalInput = z.infer<
  typeof McpKnowledgeCorrectionProposalInput
>

export const McpLocationDraftProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(10)
    .default([]),
  draft: VenueLocationDraftFieldsSchema,
}).strict()
export type McpLocationDraftProposalInput = z.infer<typeof McpLocationDraftProposalInput>

export const McpAgentImprovementProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  targetAgentIdentityId: Identifier,
  outcomeObservationIds: z.array(Identifier).min(1).max(50),
  proposalKey: z
    .string()
    .trim()
    .min(1)
    .max(191)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  revision: z.number().int().min(1).max(10_000),
  supersedesProposalId: Identifier.optional(),
  targetKind: z.enum([
    'INSTRUCTIONS',
    'ROUTING',
    'RETRIEVAL',
    'SKILL',
    'WORKFLOW',
    'TOOLING',
    'MODEL_SELECTION',
  ]),
  title: z.string().trim().min(3).max(191),
  hypothesis: z.string().trim().min(10).max(2000),
  proposedChange: z.string().trim().min(10).max(10000),
  validationPlan: z.string().trim().min(10).max(5000),
}).strict()
export type McpAgentImprovementProposalInput = z.infer<typeof McpAgentImprovementProposalInput>

export const McpAgentImprovementValidationInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  proposalId: Identifier,
  baselineEvalRunId: z.string().uuid(),
  candidateEvalRunId: z.string().uuid(),
  implementationKind: z.enum([
    'CODE_COMMIT',
    'CONFIG_VERSION',
    'PROMPT_VERSION',
    'SKILL_VERSION',
    'WORKFLOW_VERSION',
    'TOOL_VERSION',
    'MODEL_POLICY_VERSION',
  ]),
  implementationRef: z.string().trim().min(1).max(500),
  implementationVersion: z.string().trim().min(1).max(191).optional(),
  implementationHash: z.string().regex(/^[0-9a-f]{64}$/),
  changeDimensions: z
    .array(z.enum(['CONTENT', 'MODEL', 'CONFIG']))
    .min(1)
    .max(3),
}).strict()
export type McpAgentImprovementValidationInput = z.infer<typeof McpAgentImprovementValidationInput>

export const McpCustomerAccessPreparationInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  supportRequestId: Identifier,
  sourceSupportMessageId: Identifier,
  emailAddress: z.string().trim().email().max(320),
  requestedRole: z.literal('MEMBER'),
  reason: z.string().trim().min(3).max(2000),
}).strict()
export type McpCustomerAccessPreparationInput = z.infer<typeof McpCustomerAccessPreparationInput>

const McpMeetingExtractionType = z.enum([
  'SUMMARY',
  'DECISION',
  'TORCHIKO_COMMITMENT',
  'CLIENT_COMMITMENT',
  'CLIENT_PREFERENCE',
  'PRODUCT_REQUEST',
  'OBJECTION',
  'PRICING_DISCUSSION',
  'OPPORTUNITY',
  'ACTION_ITEM',
  'OPEN_QUESTION',
  'FACTUAL_CORRECTION',
])

export const McpMeetingProcessInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  meetingId: Identifier,
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  summary: z.string().trim().min(1).max(8_000),
  extractions: z
    .array(
      z
        .object({
          type: McpMeetingExtractionType,
          content: z.string().trim().min(1).max(8_000),
          structuredData: z.record(JsonValue).default({}),
          confidence: z.number().min(0).max(1).optional(),
          sourceStartOffset: z.number().int().nonnegative().optional(),
          sourceEndOffset: z.number().int().nonnegative().optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.sourceStartOffset === undefined ||
            value.sourceEndOffset === undefined ||
            value.sourceEndOffset >= value.sourceStartOffset,
          { path: ['sourceEndOffset'], message: 'Source end must not precede source start' },
        ),
    )
    .max(25),
}).strict()
export type McpMeetingProcessInput = z.infer<typeof McpMeetingProcessInput>

export const McpPackageDraftInput = McpRequestedScope.extend({
  title: z.string().trim().min(1).max(160),
  changeRequest: z.string().trim().min(1).max(10_000),
  sourceIds: z.array(Identifier).max(100).default([]),
}).strict()
export type McpPackageDraftInput = z.infer<typeof McpPackageDraftInput>

export const McpUpdateDraftInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4_000),
  startsAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.startsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Expiration must follow start',
      })
    }
  })
export type McpUpdateDraftInput = z.infer<typeof McpUpdateDraftInput>

export const McpSupportDraftInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  category: z.enum([
    'CONTENT_CORRECTION',
    'OPERATIONAL_UPDATE',
    'BRANDING',
    'EXPERIENCE_BEHAVIOR',
    'ACCESSIBILITY',
    'GENERAL',
  ]),
}).strict()
export type McpSupportDraftInput = z.infer<typeof McpSupportDraftInput>

export const McpIntakeNotesProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  notes: z.string().trim().min(1).max(20_000),
}).strict()
export type McpIntakeNotesProposalInput = z.infer<typeof McpIntakeNotesProposalInput>

export const McpWeeklyReportDraftInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  weekStart: z.string().datetime({ offset: true }),
  weekEnd: z.string().datetime({ offset: true }),
  title: z.string().trim().min(1).max(200),
})
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.weekEnd) < Date.parse(value.weekStart)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekEnd'],
        message: 'Report end must not precede start',
      })
    }
  })
export type McpWeeklyReportDraftInput = z.infer<typeof McpWeeklyReportDraftInput>

export const McpEvaluationRequestInput = McpRequestedScope.extend({
  suiteId: Identifier,
  caseIds: z.array(Identifier).min(1).max(50),
  maximumCases: z.number().int().min(1).max(50),
})
  .strict()
  .superRefine((value, context) => {
    if (value.caseIds.length > value.maximumCases) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caseIds'],
        message: 'Case count exceeds requested bound',
      })
    }
  })
export type McpEvaluationRequestInput = z.infer<typeof McpEvaluationRequestInput>

export const McpAskOperatorInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier.optional(),
  question: z.string().trim().min(1).max(2_000),
  context: z.string().trim().min(1).max(2_000).optional(),
  choices: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  blocking: z.boolean().default(true),
}).strict()
export type McpAskOperatorInput = z.infer<typeof McpAskOperatorInput>

export const McpDelegateSpecialistInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  parentAgentRunId: Identifier,
  requestingAgentIdentityId: Identifier,
  specialistAgentIdentityId: Identifier,
  instructions: z.string().trim().min(1).max(10_000),
  reason: z.string().trim().min(1).max(1_000),
}).strict()
export type McpDelegateSpecialistInput = z.infer<typeof McpDelegateSpecialistInput>

export const McpBillingProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier.optional(),
  action: z.enum(['CREATE_NEGOTIATED_CHECKOUT', 'SET_GRACE_PERIOD', 'CANCEL_AT_PERIOD_END']),
  planKey: z.string().trim().min(1).max(100).optional(),
  planVersion: z.number().int().positive().optional(),
  amountMinor: z
    .string()
    .regex(/^[1-9]\d{0,11}$/u)
    .optional(),
  interval: z.enum(['month', 'year']).optional(),
  agreementId: Identifier.optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  reference: z.string().trim().min(1).max(191).optional(),
  reason: z.string().trim().min(3).max(2000),
})
  .strict()
  .superRefine((value, context) => {
    const missing = (field: keyof typeof value) =>
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required for ${value.action}`,
      })
    if (value.action === 'CREATE_NEGOTIATED_CHECKOUT') {
      if (!value.planKey) missing('planKey')
      if (!value.amountMinor) missing('amountMinor')
      if (!value.interval) missing('interval')
      if (!value.reference) missing('reference')
    }
    if (value.action === 'SET_GRACE_PERIOD') {
      if (!value.agreementId) missing('agreementId')
      if (!value.expiresAt) missing('expiresAt')
      if (!value.reference) missing('reference')
    }
  })
export type McpBillingProposalInput = z.infer<typeof McpBillingProposalInput>

export const McpToolResult = z
  .object({ kind: Identifier, summary: Summary, data: JsonValue })
  .strict()
export type McpToolResult = z.infer<typeof McpToolResult>

export type PathfinderMcpToolName =
  | 'pathfinder.read'
  | 'torchiko.account.get_context'
  | 'torchiko.account.timeline'
  | 'torchiko.account.meetings'
  | 'torchiko.account.meeting_get'
  | 'torchiko.meeting.process'
  | 'torchiko.account.correspondence'
  | 'torchiko.knowledge.search'
  | 'torchiko.knowledge.get'
  | 'torchiko.knowledge.list_gaps'
  | 'torchiko.knowledge.propose_correction'
  | 'torchiko.locations.propose_draft'
  | 'torchiko.agent_improvements.propose'
  | 'torchiko.agent_improvements.record_validation'
  | 'torchiko.customer_access.prepare_invitation'
  | 'torchiko.integrations.health'
  | 'torchiko.reports.get_lifecycle'
  | 'pathfinder.ask_operator'
  | 'pathfinder.delegate_specialist'
  | 'pathfinder.propose_billing_action'
  | 'pathfinder.create_package_draft'
  | 'pathfinder.create_update_draft'
  | 'pathfinder.create_support_draft'
  | 'pathfinder.create_intake_notes_proposal'
  | 'pathfinder.generate_weekly_report_draft'
  | 'pathfinder.request_evaluation'

export const PATHFINDER_MCP_TOOLS: readonly PathfinderMcpToolDefinition[] = [
  {
    name: 'torchiko.account.get_context',
    title: 'Get compact account context',
    description:
      'Return the bounded Level-0/1 organization relationship projection for ordinary account work, with provenance and deeper-tool pointers.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        organizationId: { type: 'string', minLength: 1, maxLength: 120 },
        recentLimit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      },
      ['clientId'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'accounts:read', 'read') },
  },
  {
    name: 'torchiko.account.timeline',
    title: 'Get account relationship timeline',
    description:
      'Return a bounded merged timeline of significant CRM activity, correspondence, meetings, milestones, and support changes.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        organizationId: { type: 'string', minLength: 1, maxLength: 120 },
        before: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      ['clientId'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'accounts:read', 'read') },
  },
  {
    name: 'torchiko.account.meetings',
    title: 'List account meetings',
    description:
      'List bounded structured meeting summaries and processing state without loading raw transcripts or source artifacts.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        organizationId: { type: 'string', minLength: 1, maxLength: 120 },
        before: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      ['clientId'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'meetings:read', 'read') },
  },
  {
    name: 'torchiko.account.meeting_get',
    title: 'Get account meeting detail',
    description:
      'Retrieve one authorized structured meeting with participants, extraction candidates, provenance, and an optional original-artifact reference.',
    inputSchema: strictObject(
      { ...scopeProperties, meetingId: { type: 'string', minLength: 1, maxLength: 120 } },
      ['clientId', 'meetingId'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'meetings:read', 'read') },
  },
  {
    name: 'torchiko.account.correspondence',
    title: 'List account correspondence',
    description:
      'List bounded correspondence metadata and short plain-text snippets; full message bodies remain in exact source records.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        organizationId: { type: 'string', minLength: 1, maxLength: 120 },
        before: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      ['clientId'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'accounts:read', 'read') },
  },
  {
    name: 'torchiko.meeting.process',
    title: 'Record structured meeting processing',
    description:
      'Idempotently record bounded extraction candidates and complete one meeting through canonical machine-attributed actions. It does not promote candidates to authoritative knowledge.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        meetingId: { type: 'string', minLength: 1, maxLength: 120 },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        summary: { type: 'string', minLength: 1, maxLength: 8000 },
        extractions: {
          type: 'array',
          maxItems: 25,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'content'],
            properties: {
              type: { type: 'string', enum: McpMeetingExtractionType.options },
              content: { type: 'string', minLength: 1, maxLength: 8000 },
              structuredData: { type: 'object', default: {} },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              sourceStartOffset: { type: 'integer', minimum: 0 },
              sourceEndOffset: { type: 'integer', minimum: 0 },
            },
          },
          default: [],
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'meetingId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'summary',
        'extractions',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      'com.pathfinder/security': security('venue', 'meetings:process', 'interaction'),
    },
  },
  {
    name: 'torchiko.customer_access.prepare_invitation',
    title: 'Prepare a customer team invitation',
    description:
      'Prepare one idempotent tenant-wide member invitation from an exact active owner-authored support message. It creates a high-risk founder approval item and never contacts Clerk, sends email, or changes membership.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        supportRequestId: { type: 'string', minLength: 1, maxLength: 120 },
        sourceSupportMessageId: { type: 'string', minLength: 1, maxLength: 120 },
        emailAddress: { type: 'string', format: 'email', maxLength: 320 },
        requestedRole: { type: 'string', enum: ['MEMBER'] },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'supportRequestId',
        'sourceSupportMessageId',
        'emailAddress',
        'requestedRole',
        'reason',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      'com.pathfinder/security': {
        ...security('venue', 'customer-access:prepare', 'interaction'),
        risk: 'moderate',
      },
    },
  },
  {
    name: 'torchiko.knowledge.search',
    title: 'Search Company Knowledge',
    description:
      'Search promoted institutional memory with authority, entity, and tenant filters applied before result selection.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        query: { type: 'string', minLength: 2, maxLength: 1000 },
        organizationId: { type: 'string', minLength: 1, maxLength: 120 },
        types: { type: 'array', maxItems: 17, items: { type: 'string' }, default: [] },
        authorities: { type: 'array', maxItems: 5, items: { type: 'string' } },
        includeHistorical: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      ['clientId', 'query'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'knowledge:read', 'read') },
  },
  {
    name: 'torchiko.knowledge.get',
    title: 'Get Company Knowledge detail',
    description:
      'Retrieve one exact authorized knowledge item with its current revision, provenance, decision data, and supersession state.',
    inputSchema: strictObject(
      { ...scopeProperties, knowledgeItemId: { type: 'string', minLength: 1, maxLength: 120 } },
      ['clientId', 'knowledgeItemId'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'knowledge:read', 'read') },
  },
  {
    name: 'torchiko.knowledge.list_gaps',
    title: 'List reviewable visitor knowledge gaps',
    description:
      'Return a bounded venue-scoped queue of public visitor questions and assistant answers already flagged by deterministic retrieval-quality rules. No visitor identity or location is returned.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
      },
      scopeRequired,
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'conversations:review', 'read') },
  },
  {
    name: 'torchiko.knowledge.propose_correction',
    title: 'Prepare a visitor-answer correction',
    description:
      'Create one idempotent, evidence-linked knowledge or retrieval correction for human review. It never edits, publishes, retires, or re-embeds canonical venue knowledge.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        conversationInsightId: { type: 'string', format: 'uuid' },
        targetKnowledgeEntryId: { type: 'string', minLength: 1, maxLength: 120 },
        correctionKind: {
          type: 'string',
          enum: [
            'CREATE_KNOWLEDGE',
            'UPDATE_KNOWLEDGE',
            'RETIRE_KNOWLEDGE',
            'RETRIEVAL_CORRECTION',
            'NO_CONTENT_CHANGE',
          ],
        },
        aiInference: { type: 'string', minLength: 1, maxLength: 2000 },
        proposedChange: { type: 'string', minLength: 1, maxLength: 10000 },
        reason: { type: 'string', minLength: 1, maxLength: 2000 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'conversationInsightId',
        'correctionKind',
        'aiInference',
        'proposedChange',
        'reason',
        'confidence',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'knowledge:draft', 'interaction') },
  },
  {
    name: 'torchiko.locations.propose_draft',
    title: 'Propose an inactive venue location draft',
    description:
      'Prepare one typed venue location anchor for human review. Approval and application remain separate, and this tool never creates, edits, activates, or publishes venue content.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
        evidence: {
          type: 'array',
          maxItems: 10,
          default: [],
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'id'],
            properties: {
              type: { type: 'string', minLength: 1, maxLength: 100 },
              id: { type: 'string', minLength: 1, maxLength: 120 },
            },
          },
        },
        draft: {
          type: 'object',
          additionalProperties: false,
          required: ['stableKey', 'kind', 'displayName'],
          properties: {
            stableKey: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 100 },
            kind: { type: 'string', enum: VenueLocationDraftFieldsSchema.shape.kind.options },
            displayName: { type: 'string', minLength: 1, maxLength: 191 },
            description: { type: ['string', 'null'], maxLength: 2000, default: null },
            visibility: { type: 'string', enum: ['PUBLIC', 'SECOND_LAYER'], default: 'PUBLIC' },
            floorId: { type: ['string', 'null'], format: 'uuid', default: null },
            parentLocationId: { type: ['string', 'null'], format: 'uuid', default: null },
            coordinates: {
              type: ['object', 'null'],
              default: null,
              additionalProperties: false,
              required: ['latitude', 'longitude'],
              properties: {
                latitude: { type: 'number', minimum: -90, maximum: 90 },
                longitude: { type: 'number', minimum: -180, maximum: 180 },
              },
            },
            mapAnchor: {
              type: ['object', 'null'],
              default: null,
              additionalProperties: false,
              required: ['x', 'y'],
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
            externalMapReference: {
              type: ['string', 'null'],
              format: 'uri',
              maxLength: 2000,
              default: null,
            },
            accessibilityMetadata: {
              type: 'object',
              maxProperties: 20,
              additionalProperties: { type: ['string', 'number', 'boolean'] },
              default: {},
            },
          },
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'reason',
        'draft',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'locations:propose', 'interaction') },
  },
  {
    name: 'torchiko.agent_improvements.propose',
    title: 'Propose an evidence-backed agent improvement',
    description:
      'Prepare one versioned improvement hypothesis from exact outcome observations for human review. Approval never applies the change or expands agent authority.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        targetAgentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        outcomeObservationIds: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 120 },
        },
        proposalKey: { type: 'string', minLength: 1, maxLength: 191 },
        revision: { type: 'integer', minimum: 1, maximum: 10000 },
        supersedesProposalId: { type: 'string', minLength: 1, maxLength: 120 },
        targetKind: {
          type: 'string',
          enum: [
            'INSTRUCTIONS',
            'ROUTING',
            'RETRIEVAL',
            'SKILL',
            'WORKFLOW',
            'TOOLING',
            'MODEL_SELECTION',
          ],
        },
        title: { type: 'string', minLength: 3, maxLength: 191 },
        hypothesis: { type: 'string', minLength: 10, maxLength: 2000 },
        proposedChange: { type: 'string', minLength: 10, maxLength: 10000 },
        validationPlan: { type: 'string', minLength: 10, maxLength: 5000 },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'targetAgentIdentityId',
        'outcomeObservationIds',
        'proposalKey',
        'revision',
        'targetKind',
        'title',
        'hypothesis',
        'proposedChange',
        'validationPlan',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      'com.pathfinder/security': security('venue', 'agent-improvements:propose', 'interaction'),
    },
  },
  {
    name: 'torchiko.agent_improvements.record_validation',
    title: 'Record reviewed agent improvement validation evidence',
    description:
      'Bind an approved proposal to one immutable implementation reference and comparable before/after evaluation runs. This records evidence only and never promotes behavior or authority.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        proposalId: { type: 'string', minLength: 1, maxLength: 120 },
        baselineEvalRunId: { type: 'string', format: 'uuid' },
        candidateEvalRunId: { type: 'string', format: 'uuid' },
        implementationKind: {
          type: 'string',
          enum: [
            'CODE_COMMIT',
            'CONFIG_VERSION',
            'PROMPT_VERSION',
            'SKILL_VERSION',
            'WORKFLOW_VERSION',
            'TOOL_VERSION',
            'MODEL_POLICY_VERSION',
          ],
        },
        implementationRef: { type: 'string', minLength: 1, maxLength: 500 },
        implementationVersion: { type: 'string', minLength: 1, maxLength: 191 },
        implementationHash: {
          type: 'string',
          minLength: 64,
          maxLength: 64,
          pattern: '^[0-9a-f]{64}$',
        },
        changeDimensions: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { type: 'string', enum: ['CONTENT', 'MODEL', 'CONFIG'] },
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'proposalId',
        'baselineEvalRunId',
        'candidateEvalRunId',
        'implementationKind',
        'implementationRef',
        'implementationHash',
        'changeDimensions',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      'com.pathfinder/security': security('venue', 'agent-improvements:validate', 'interaction'),
    },
  },
  {
    name: 'torchiko.reports.get_lifecycle',
    title: 'Get weekly report lifecycle',
    description:
      'Return one privacy-bounded report generation, source-count, review, publication, and delivery-state projection without raw report content or provider errors.',
    inputSchema: strictObject(
      { ...scopeProperties, reportId: { type: 'string', minLength: 1, maxLength: 120 } },
      [...scopeRequired, 'reportId'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'reports:read', 'read') },
  },
  {
    name: 'torchiko.integrations.health',
    title: 'Get unified integration health',
    description:
      'Return bounded secret-free integration and operational-control health, including global AI admission and active expiring provider exclusions without incident reasons or operator identity.',
    inputSchema: strictObject(scopeProperties, ['clientId']),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'integrations:read', 'read') },
  },
  {
    name: 'pathfinder.propose_billing_action',
    title: 'Propose a billing action',
    description:
      'Record an exact, idempotent negotiated Checkout, grace-period, or cancellation proposal for human approval. This tool never changes Stripe or customer access.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        action: {
          type: 'string',
          enum: ['CREATE_NEGOTIATED_CHECKOUT', 'SET_GRACE_PERIOD', 'CANCEL_AT_PERIOD_END'],
        },
        planKey: { type: 'string', minLength: 1, maxLength: 100 },
        planVersion: { type: 'integer', minimum: 1 },
        amountMinor: { type: 'string', pattern: '^[1-9][0-9]{0,11}$' },
        interval: { type: 'string', enum: ['month', 'year'] },
        agreementId: { type: 'string', minLength: 1, maxLength: 120 },
        expiresAt: { type: 'string', format: 'date-time' },
        reference: { type: 'string', minLength: 1, maxLength: 191 },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
      },
      [...scopeRequired, 'operationId', 'agentIdentityId', 'action', 'reason'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'billing:propose', 'interaction') },
  },
  {
    name: 'pathfinder.read',
    title: 'Read Torchiko data',
    description:
      'Read an authorized client or venue resource. Tenant authority comes only from the verified credential.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        resource: { type: 'string', enum: resourceSeeds.map(([name]) => name) },
        agentRunId: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Required only when resource is agent-run-trace.',
        },
        cursor: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      ['clientId', 'resource'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('client-or-venue', 'resources:read', 'read') },
  },
  {
    name: 'pathfinder.ask_operator',
    title: 'Ask the operator',
    description:
      'Raise a durable, venue-scoped clarification in the Agent workspace. It does not approve or execute any action.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        question: { type: 'string', minLength: 1, maxLength: 2000 },
        context: { type: 'string', minLength: 1, maxLength: 2000 },
        choices: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 200 },
          default: [],
        },
        blocking: { type: 'boolean', default: true },
      },
      [...scopeRequired, 'operationId', 'agentIdentityId', 'question'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'questions:ask', 'interaction') },
  },
  {
    name: 'pathfinder.delegate_specialist',
    title: 'Delegate to a specialist',
    description:
      'Create an idempotent child run for an enabled in-scope specialist. The active parent run remains the authority boundary.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        parentAgentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        requestingAgentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        specialistAgentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        instructions: { type: 'string', minLength: 1, maxLength: 10000 },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      [
        ...scopeRequired,
        'operationId',
        'parentAgentRunId',
        'requestingAgentIdentityId',
        'specialistAgentIdentityId',
        'instructions',
        'reason',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'delegations:create', 'interaction') },
  },
  {
    name: 'pathfinder.create_package_draft',
    title: 'Draft a venue package',
    description:
      'Create a reviewable package draft only. It cannot approve, apply, publish, or roll back a package.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        title: { type: 'string', minLength: 1, maxLength: 160 },
        changeRequest: { type: 'string', minLength: 1, maxLength: 10000 },
        sourceIds: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', minLength: 1, maxLength: 120 },
          default: [],
        },
      },
      [...scopeRequired, 'title', 'changeRequest'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'packages:draft', 'draft') },
  },
  {
    name: 'pathfinder.create_update_draft',
    title: 'Draft an operational update',
    description: 'Create a temporary operational-update draft only. It cannot publish the update.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        body: { type: 'string', minLength: 1, maxLength: 4000 },
        startsAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'title',
        'body',
        'startsAt',
        'expiresAt',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'updates:draft', 'draft') },
  },
  {
    name: 'pathfinder.create_support_draft',
    title: 'Draft a support request',
    description:
      'Create a support-request draft only. It cannot send client-visible messages or apply changes.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', minLength: 1, maxLength: 20000 },
        category: {
          type: 'string',
          enum: [
            'CONTENT_CORRECTION',
            'OPERATIONAL_UPDATE',
            'BRANDING',
            'EXPERIENCE_BEHAVIOR',
            'ACCESSIBILITY',
            'GENERAL',
          ],
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'subject',
        'body',
        'category',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'support:draft', 'draft') },
  },
  {
    name: 'pathfinder.create_intake_notes_proposal',
    title: 'Prepare onboarding notes for review',
    description:
      'Create a NOTES-only intake proposal in awaiting-review state. It cannot extract, create or apply a package, publish, or contact a customer.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        notes: { type: 'string', minLength: 1, maxLength: 20000 },
      },
      [...scopeRequired, 'operationId', 'agentIdentityId', 'agentRunId', 'workerKey', 'notes'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'intake:draft', 'draft') },
  },
  {
    name: 'pathfinder.generate_weekly_report_draft',
    title: 'Generate a weekly report draft',
    description:
      'Create or replay a bounded internal weekly-report generation request. It can consume configured AI budget, but it cannot publish, deliver, edit, or make the report client-visible.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        weekStart: { type: 'string', format: 'date-time' },
        weekEnd: { type: 'string', format: 'date-time' },
        title: { type: 'string', minLength: 1, maxLength: 200 },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'weekStart',
        'weekEnd',
        'title',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'reports:draft', 'draft') },
  },
  {
    name: 'pathfinder.request_evaluation',
    title: 'Request a bounded evaluation',
    description:
      'Request an approved, bounded evaluation run. It cannot define cases, change thresholds, or publish results.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        suiteId: { type: 'string', minLength: 1, maxLength: 120 },
        caseIds: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string', minLength: 1, maxLength: 120 },
        },
        maximumCases: { type: 'integer', minimum: 1, maximum: 50 },
      },
      [...scopeRequired, 'suiteId', 'caseIds', 'maximumCases'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      'com.pathfinder/security': security(
        'venue',
        'evaluations:request',
        'bounded-evaluation-request',
      ),
    },
  },
]

const toolNamePattern = /^[A-Za-z0-9_.-]{1,128}$/

export function validatePathfinderMcpCatalog(): void {
  const names = [
    ...PATHFINDER_MCP_RESOURCES.map(({ name }) => name),
    ...PATHFINDER_MCP_TOOLS.map(({ name }) => name),
  ]
  if (new Set(names).size !== names.length) throw new Error('MCP catalog names must be unique')
  for (const name of names)
    if (!toolNamePattern.test(name)) throw new Error(`Invalid MCP name: ${name}`)
  for (const tool of PATHFINDER_MCP_TOOLS) {
    if (tool.inputSchema.type !== 'object' || tool.inputSchema.additionalProperties !== false) {
      throw new Error(`Tool ${tool.name} must have a strict object input schema`)
    }
    if (!tool.outputSchema) throw new Error(`Tool ${tool.name} must declare an output schema`)
    const metadata = tool._meta['com.pathfinder/security']
    if (tool.annotations.readOnlyHint !== (metadata.effect === 'read')) {
      throw new Error(`Tool ${tool.name} risk metadata is contradictory`)
    }
    if (
      (metadata.effect === 'draft' || metadata.effect === 'bounded-evaluation-request') &&
      (metadata.defaultEnabled || !metadata.approvalRequired)
    ) {
      throw new Error(`Tool ${tool.name} must remain default-off and approval-gated`)
    }
    if (
      metadata.effect === 'interaction' &&
      (!metadata.defaultEnabled || metadata.approvalRequired)
    ) {
      throw new Error(`Tool ${tool.name} interaction metadata is contradictory`)
    }
  }
}

/** MCP 2026-07-28 structured output plus the recommended backwards-compatible JSON text block. */
export function toMcpStructuredResult(result: McpToolResult): {
  resultType: 'complete'
  structuredContent: McpToolResult
  content: [{ type: 'text'; text: string }]
  isError: false
} {
  const parsed = McpToolResult.parse(result)
  return {
    resultType: 'complete',
    structuredContent: parsed,
    content: [{ type: 'text', text: JSON.stringify(parsed) }],
    isError: false,
  }
}
