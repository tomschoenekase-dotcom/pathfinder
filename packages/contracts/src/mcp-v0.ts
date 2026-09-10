import { z } from 'zod'

import {
  SupportPackageApprovalApplyParameters,
  SupportPackageApplicationApplyParameters,
  SupersededSupportPackageHandoff,
  ReplacementSupportPackageHandoff,
  SupportPackageReversionApplyParameters,
  SupportPackageDraftApplyParameters,
} from './agent-approval-policy'
import { VenueLocationDraftFieldsSchema } from './location-authoring'
import { SupportRequestCategory } from './support-workflow'
import { GeneralizedContentRevisionDraft } from './universal-content-actions'
import { CreateLegacyKnowledgeAdoptionDraftInput } from './legacy-knowledge-adoption'
import {
  AgentWorkflowPortableManifestSchema,
  AgentWorkflowProvenanceSchema,
} from './agent-workflow-registry'

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
  'retention:read',
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
  'packages:approve',
  'packages:apply',
  'packages:reconcile',
  'packages:revert',
  'support:draft',
  'support:open',
  'support:note',
  'support:triage',
  'support:request-information',
  'support:complete',
  'intake:draft',
  'intake-source:read',
  'updates:draft',
  'evaluations:request',
  'characters:build',
  'characters:execute',
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
  if (level === 'venue' && !request.venueId) throw new McpScopeError('Venue scope is required')
  if ((level === 'venue' || level === 'client-or-venue') && request.venueId) {
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
  effect: 'read' | 'interaction' | 'draft' | 'approved-transition' | 'bounded-evaluation-request'
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
  const approvalRequired =
    effect === 'draft' ||
    effect === 'approved-transition' ||
    effect === 'bounded-evaluation-request'
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
    'agent-run-result',
    'Agent run result',
    'One exact venue-scoped run result manifest or indexed whole artifact without prompts, execution authority, or credential material.',
    'pathfinder://clients/{clientId}/venues/{venueId}/agent-runs/{agentRunId}/result',
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
    'retention-preview',
    'Retention disposition preview',
    'Full-client, read-only database count and policy-coverage evidence; never authorizes deletion, anonymization, revocation, or external provider action.',
    'pathfinder://clients/{clientId}/retention-preview',
    'client',
    'retention:read',
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
    'assigned-source',
    'Assigned task source',
    'One bounded page from the claimed Content run’s immutable source assignment, before a question exists.',
    'pathfinder://clients/{clientId}/venues/{venueId}/agent-runs/{agentRunId}/source',
    'venue',
    'intake-source:read',
  ],
  [
    'question-source',
    'Agent question source',
    'One bounded, question-bound intake extraction source page for the claimed agent run.',
    'pathfinder://clients/{clientId}/venues/{venueId}/agent-questions/{questionId}/source',
    'venue',
    'intake-source:read',
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
  questionId: Identifier.optional(),
  artifactIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  artifactOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  sourceCursor: z.string().trim().min(1).max(1024).optional(),
  pageSize: z.number().int().min(1).max(4000).optional(),
  search: z.string().trim().min(1).max(200).optional(),
})
  .strict()
  .superRefine((value, context) => {
    const exactRunResource = [
      'agent-run-trace',
      'agent-run-result',
      'question-source',
      'assigned-source',
    ].includes(value.resource)
    if (exactRunResource && !value.agentRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'agentRunId is required for an exact agent run resource.',
      })
    }
    if (!exactRunResource && value.agentRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentRunId'],
        message: 'agentRunId is only accepted for an exact agent run resource.',
      })
    }
    const questionSource = value.resource === 'question-source'
    const sourceResource = questionSource || value.resource === 'assigned-source'
    if (questionSource && !value.questionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['questionId'],
        message: 'questionId is required for a question source resource.',
      })
    }
    if (!questionSource && value.questionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['questionId'],
        message: 'questionId is only accepted for a question source resource.',
      })
    }
    for (const field of ['sourceCursor', 'pageSize', 'search'] as const) {
      if (!sourceResource && value[field] !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is only accepted for a worker source resource.`,
        })
      }
    }
    if (sourceResource && value.cursor !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'Source pages do not accept a generic cursor.',
      })
    }
    if (value.resource !== 'agent-run-result' && value.artifactIndex !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactIndex'],
        message: 'artifactIndex is only accepted for an agent run result.',
      })
    }
    if (value.resource === 'agent-run-result' && value.cursor !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'agent-run-result does not accept a cursor.',
      })
    }
    if (value.artifactOffset !== undefined && value.artifactIndex === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactOffset'],
        message: 'artifactOffset requires artifactIndex.',
      })
    }
    if (value.resource !== 'agent-run-result' && value.artifactOffset !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactOffset'],
        message: 'artifactOffset is only accepted for an agent run result.',
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
  cursor: z.string().min(1).max(2000).optional(),
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

export const McpGuestAnswerAttributionListInput = McpRequestedScope.extend({
  guestChatTurnId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(10),
}).strict()
export type McpGuestAnswerAttributionListInput = z.infer<typeof McpGuestAnswerAttributionListInput>

export const McpGuestAnswerAttributionAgreementInput = McpRequestedScope.extend({
  limit: z.number().int().min(2).max(100).default(100),
}).strict()
export type McpGuestAnswerAttributionAgreementInput = z.infer<
  typeof McpGuestAnswerAttributionAgreementInput
>

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

export const McpSupportKnowledgeProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  supportRequestId: Identifier,
  expectedVersion: z.number().int().positive(),
  evidenceMessageIds: z
    .array(Identifier)
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Evidence messages must be unique.'),
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
export type McpSupportKnowledgeProposalInput = z.infer<typeof McpSupportKnowledgeProposalInput>

export const McpSemanticUniversalContentDraftInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  proposalId: z.string().uuid(),
  expectedProposalUpdatedAt: z.string().datetime({ offset: true }),
  expectedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
  relation: z.enum(['NEW_FACT', 'CORRECTS', 'SUPERSEDES']),
  desired: z
    .object({
      title: z.string().trim().min(1).max(200),
      category: z.string().trim().min(1).max(100),
      content: z.string().trim().min(1).max(5000),
      isEnabled: z.boolean(),
    })
    .strict(),
  draft: GeneralizedContentRevisionDraft,
}).strict()
export type McpSemanticUniversalContentDraftInput = z.infer<
  typeof McpSemanticUniversalContentDraftInput
>

export const McpLegacyKnowledgeAdoptionDraftInput = CreateLegacyKnowledgeAdoptionDraftInput.extend({
  clientId: Identifier,
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
}).strict()
export type McpLegacyKnowledgeAdoptionDraftInput = z.infer<
  typeof McpLegacyKnowledgeAdoptionDraftInput
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

export const McpSupportTriageProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
  category: SupportRequestCategory,
  missingInformation: z
    .array(z.string().trim().min(1).max(500))
    .max(30)
    .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(10)
    .default([]),
}).strict()
export type McpSupportTriageProposalInput = z.infer<typeof McpSupportTriageProposalInput>

export const McpSupportTriageApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
  category: SupportRequestCategory,
  missingInformation: z
    .array(z.string().trim().min(1).max(500))
    .max(30)
    .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
}).strict()
export type McpSupportTriageApplyInput = z.infer<typeof McpSupportTriageApplyInput>

const SupportInformationRequestFields = {
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
  fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
  body: z.string().trim().min(1).max(20_000),
  missingInformation: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(30)
    .refine((items) => new Set(items).size === items.length, 'Items must be unique'),
}

export const McpSupportInformationRequestProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportInformationRequestFields,
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(10)
    .default([]),
}).strict()
export type McpSupportInformationRequestProposalInput = z.infer<
  typeof McpSupportInformationRequestProposalInput
>

export const McpSupportInformationRequestApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportInformationRequestFields,
}).strict()

const SupportCompletionFields = {
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
  fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
  body: z.string().trim().min(1).max(20_000),
}

export const McpSupportCompletionProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportCompletionFields,
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(10)
    .default([]),
}).strict()
export type McpSupportCompletionProposalInput = z.infer<typeof McpSupportCompletionProposalInput>

export const McpSupportCompletionApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportCompletionFields,
}).strict()
export type McpSupportCompletionApplyInput = z.infer<typeof McpSupportCompletionApplyInput>
export type McpSupportInformationRequestApplyInput = z.infer<
  typeof McpSupportInformationRequestApplyInput
>

const SupportPackageDraftFields = {
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
  fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
  draftKey: z.string().uuid(),
  payload: z.record(JsonValue),
  operationCounts: SupportPackageDraftApplyParameters.shape.operationCounts,
}

export const McpSupportPackageDraftProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportPackageDraftFields,
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(20)
    .default([]),
}).strict()
export type McpSupportPackageDraftProposalInput = z.infer<
  typeof McpSupportPackageDraftProposalInput
>

export const McpSupportPackageDraftApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportPackageDraftFields,
}).strict()
export type McpSupportPackageDraftApplyInput = z.infer<typeof McpSupportPackageDraftApplyInput>

const SupportPackageApprovalFields = {
  packageId: Identifier,
  expectedUpdatedAt: z.string().datetime(),
  payloadHash: SupportPackageApprovalApplyParameters.shape.payloadHash,
  baseDigest: SupportPackageApprovalApplyParameters.shape.baseDigest,
  warningDigest: SupportPackageApprovalApplyParameters.shape.warningDigest,
  supportHandoff: SupportPackageApprovalApplyParameters.shape.supportHandoff,
}

export const McpSupportPackageApprovalProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  packageId: Identifier,
  expectedUpdatedAt: z.string().datetime(),
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(20)
    .default([]),
}).strict()
export type McpSupportPackageApprovalProposalInput = z.infer<
  typeof McpSupportPackageApprovalProposalInput
>

export const McpSupportPackageApprovalApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportPackageApprovalFields,
}).strict()
export type McpSupportPackageApprovalApplyInput = z.infer<
  typeof McpSupportPackageApprovalApplyInput
>

const SupportPackageApplicationFields = {
  packageId: Identifier,
  expectedUpdatedAt: z.string().datetime(),
  payloadHash: SupportPackageApplicationApplyParameters.shape.payloadHash,
  baseDigest: SupportPackageApplicationApplyParameters.shape.baseDigest,
  warningDigest: SupportPackageApplicationApplyParameters.shape.warningDigest,
  approvedAt: SupportPackageApplicationApplyParameters.shape.approvedAt,
  approvedBy: SupportPackageApplicationApplyParameters.shape.approvedBy,
  supportHandoff: SupportPackageApplicationApplyParameters.shape.supportHandoff,
}

export const McpSupportPackageApplicationProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  packageId: Identifier,
  expectedUpdatedAt: z.string().datetime(),
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(20)
    .default([]),
}).strict()
export type McpSupportPackageApplicationProposalInput = z.infer<
  typeof McpSupportPackageApplicationProposalInput
>

export const McpSupportPackageApplicationApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportPackageApplicationFields,
}).strict()
export type McpSupportPackageApplicationApplyInput = z.infer<
  typeof McpSupportPackageApplicationApplyInput
>

const SupportPackageReversionFields = {
  packageId: Identifier,
  expectedUpdatedAt: z.string().datetime(),
  payloadHash: SupportPackageReversionApplyParameters.shape.payloadHash,
  baseDigest: SupportPackageReversionApplyParameters.shape.baseDigest,
  rollbackManifestDigest: SupportPackageReversionApplyParameters.shape.rollbackManifestDigest,
  appliedAt: SupportPackageReversionApplyParameters.shape.appliedAt,
  appliedBy: SupportPackageReversionApplyParameters.shape.appliedBy,
  appliedCommandKey: SupportPackageReversionApplyParameters.shape.appliedCommandKey,
  supportHandoff: SupportPackageReversionApplyParameters.shape.supportHandoff,
  supportRequestVersion: SupportPackageReversionApplyParameters.shape.supportRequestVersion,
  supportRequestStatus: SupportPackageReversionApplyParameters.shape.supportRequestStatus,
}

export const McpSupportPackageReversionProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  packageId: Identifier,
  expectedUpdatedAt: z.string().datetime(),
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(20)
    .default([]),
}).strict()
export type McpSupportPackageReversionProposalInput = z.infer<
  typeof McpSupportPackageReversionProposalInput
>

export const McpSupportPackageReversionApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportPackageReversionFields,
}).strict()
export type McpSupportPackageReversionApplyInput = z.infer<
  typeof McpSupportPackageReversionApplyInput
>

const SupportPackageHandoffSupersessionFields = {
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
  supportRequestStatus: z.enum(['OPEN', 'IN_REVIEW']),
  superseded: SupersededSupportPackageHandoff,
  replacement: ReplacementSupportPackageHandoff,
}

export const McpSupportPackageHandoffSupersessionProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
  supersededHandoffId: Identifier,
  replacementHandoffId: Identifier,
  reason: z.string().trim().min(3).max(2000),
  evidence: z
    .array(z.object({ type: z.string().trim().min(1).max(100), id: Identifier }).strict())
    .max(20)
    .default([]),
}).strict()
export type McpSupportPackageHandoffSupersessionProposalInput = z.infer<
  typeof McpSupportPackageHandoffSupersessionProposalInput
>

export const McpSupportPackageHandoffSupersessionApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  ...SupportPackageHandoffSupersessionFields,
}).strict()
export type McpSupportPackageHandoffSupersessionApplyInput = z.infer<
  typeof McpSupportPackageHandoffSupersessionApplyInput
>

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
  generalization: z
    .object({
      rationale: z.string().trim().min(10).max(2000),
      counterexampleObservationIds: z
        .array(Identifier)
        .min(1)
        .max(20)
        .refine((ids) => new Set(ids).size === ids.length, 'IDs must be unique.'),
      exclusions: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
    })
    .strict()
    .optional(),
}).strict()
export type McpAgentImprovementProposalInput = z.infer<typeof McpAgentImprovementProposalInput>

export const McpAgentWorkflowVersionsReadInput = McpRequestedScope.extend({
  registryKeys: z.array(z.string().min(1).max(191)).min(1).max(5),
}).strict()
export type McpAgentWorkflowVersionsReadInput = z.infer<typeof McpAgentWorkflowVersionsReadInput>

export const McpAgentWorkflowVersionRegistrationInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  manifest: AgentWorkflowPortableManifestSchema,
  portableText: z.string().trim().min(1).max(50_000),
  provenance: AgentWorkflowProvenanceSchema,
  supersedesVersionId: z.string().uuid().optional(),
}).strict()
export type McpAgentWorkflowVersionRegistrationInput = z.infer<
  typeof McpAgentWorkflowVersionRegistrationInput
>

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

export const McpIntakeV1PackagePreviewInput = McpRequestedScope.extend({
  submissionId: Identifier,
  revision: z.number().int().min(1),
  selectedMemberIds: z.array(Identifier).min(1).max(50),
})
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.selectedMemberIds).size !== value.selectedMemberIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedMemberIds'],
        message: 'Selected V1 member IDs must be unique.',
      })
    }
  })
export type McpIntakeV1PackagePreviewInput = z.infer<typeof McpIntakeV1PackagePreviewInput>

const McpIntakeV1PackageIdentityFields = {
  submissionId: Identifier,
  revision: z.number().int().min(1),
  selectedMemberIds: z.array(Identifier).min(1).max(50),
  expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSelectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  partialAcknowledged: z.boolean(),
  draftOperationId: z.string().uuid(),
}
export const McpIntakeV1PackageDraftProposalInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  executionLeaseToken: z.string().uuid(),
  ...McpIntakeV1PackageIdentityFields,
  reason: z.string().trim().min(3).max(2_000),
})
  .strict()
  .refine((value) => new Set(value.selectedMemberIds).size === value.selectedMemberIds.length, {
    path: ['selectedMemberIds'],
    message: 'Selected V1 member IDs must be unique.',
  })
export type McpIntakeV1PackageDraftProposalInput = z.infer<
  typeof McpIntakeV1PackageDraftProposalInput
>
export const McpIntakeV1PackageDraftApplyInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  executionLeaseToken: z.string().uuid(),
  ...McpIntakeV1PackageIdentityFields,
})
  .strict()
  .refine((value) => new Set(value.selectedMemberIds).size === value.selectedMemberIds.length, {
    path: ['selectedMemberIds'],
    message: 'Selected V1 member IDs must be unique.',
  })
export type McpIntakeV1PackageDraftApplyInput = z.infer<typeof McpIntakeV1PackageDraftApplyInput>

export const McpUpdateDraftInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  executionLeaseToken: z.string().uuid().optional(),
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
  executionLeaseToken: z.string().uuid().optional(),
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

export const McpSupportOpenInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
}).strict()
export type McpSupportOpenInput = z.infer<typeof McpSupportOpenInput>

export const McpSupportInternalNoteInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  workerKey: Identifier,
  executionLeaseToken: z.string().uuid().optional(),
  requestId: Identifier,
  expectedVersion: z.number().int().positive(),
  body: z.string().trim().min(1).max(20_000),
}).strict()
export type McpSupportInternalNoteInput = z.infer<typeof McpSupportInternalNoteInput>

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

export const McpSourceClarification = z
  .object({
    runId: z.string().trim().min(1).max(191),
    receiptId: z.string().uuid(),
    expectedExtractedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    fieldPath: z.string().trim().min(1).max(500),
    reason: z.enum(['CONTRADICTION', 'DATE_SENSITIVE', 'LOW_CONFIDENCE', 'MISSING_CONTEXT']),
    blockerScope: z.enum(['LOCAL', 'FOUNDATIONAL']),
    evidenceExcerpt: z.string().trim().min(1).max(1000),
  })
  .strict()

const McpGenericOperatorQuestion = McpRequestedScope.extend({
  sourceClarification: z.undefined().optional(),
  operationId: z.string().uuid(),
  agentIdentityId: Identifier,
  agentRunId: Identifier.optional(),
  question: z.string().trim().min(1).max(2_000),
  context: z.string().trim().min(1).max(2_000).optional(),
  choices: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  blocking: z.boolean().default(true),
}).strict()

const McpSourceOperatorQuestion = McpRequestedScope.extend({
  agentIdentityId: Identifier,
  agentRunId: Identifier,
  question: z.string().trim().min(1).max(2_000),
  sourceClarification: McpSourceClarification,
})
  .strict()
  .transform((value) => ({
    ...value,
    operationId: undefined,
    context: undefined,
    choices: [] as string[],
    expiresAt: undefined,
    blocking: value.sourceClarification.blockerScope === 'FOUNDATIONAL',
  }))

// Source replay identity is derived canonically from exact source/question/run data.
// Generic operation IDs and lifecycle overrides must not override that identity.
export const McpAskOperatorInput = z.union([McpGenericOperatorQuestion, McpSourceOperatorQuestion])
export type McpAskOperatorInput = z.infer<typeof McpAskOperatorInput>

export const McpDelegateSpecialistInput = McpRequestedScope.extend({
  operationId: z.string().uuid(),
  parentAgentRunId: Identifier,
  requestingAgentIdentityId: Identifier,
  specialistAgentIdentityId: Identifier,
  instructions: z.string().trim().min(1).max(10_000),
  reason: z.string().trim().min(1).max(1_000),
  executionLeaseToken: z.string().uuid().optional(),
  waitForResult: z.boolean().default(false),
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
  | 'torchiko.quality.list_answer_attributions'
  | 'torchiko.quality.preview_answer_attribution_agreement'
  | 'torchiko.knowledge.propose_correction'
  | 'torchiko.knowledge.prepare_from_support'
  | 'torchiko.knowledge.create_typed_draft'
  | 'torchiko.knowledge.adopt_legacy_draft'
  | 'torchiko.locations.propose_draft'
  | 'pathfinder.propose_support_triage'
  | 'pathfinder.apply_support_triage'
  | 'pathfinder.propose_support_information_request'
  | 'pathfinder.apply_support_information_request'
  | 'pathfinder.propose_support_completion'
  | 'pathfinder.apply_support_completion'
  | 'pathfinder.propose_support_package_draft'
  | 'pathfinder.apply_support_package_draft'
  | 'pathfinder.propose_support_package_approval'
  | 'pathfinder.apply_support_package_approval'
  | 'pathfinder.propose_support_package_application'
  | 'pathfinder.apply_support_package_application'
  | 'pathfinder.propose_support_package_reversion'
  | 'pathfinder.apply_support_package_reversion'
  | 'pathfinder.propose_support_package_handoff_supersession'
  | 'pathfinder.apply_support_package_handoff_supersession'
  | 'torchiko.agent_improvements.propose'
  | 'torchiko.agent_workflows.register_version'
  | 'torchiko.agent_workflows.get_compatible_versions'
  | 'torchiko.agent_improvements.record_validation'
  | 'torchiko.customer_access.prepare_invitation'
  | 'torchiko.integrations.health'
  | 'torchiko.reports.get_lifecycle'
  | 'pathfinder.ask_operator'
  | 'pathfinder.delegate_specialist'
  | 'pathfinder.propose_billing_action'
  | 'pathfinder.create_package_draft'
  | 'pathfinder.preview_intake_v1_package_draft'
  | 'pathfinder.propose_intake_v1_package_draft'
  | 'pathfinder.apply_intake_v1_package_draft'
  | 'pathfinder.create_update_draft'
  | 'pathfinder.create_support_draft'
  | 'pathfinder.open_support_request'
  | 'pathfinder.add_support_internal_note'
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
        cursor: { type: 'string', minLength: 1, maxLength: 2000 },
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
    name: 'torchiko.quality.list_answer_attributions',
    title: 'List reviewed guest-answer claim attributions',
    description:
      'Return bounded, append-only claim support annotations for exact public guest answers. Results are evaluator-attributed evidence and descriptive metrics, never an automatic quality or release decision.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        guestChatTurnId: { type: 'string', format: 'uuid' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
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
    name: 'torchiko.quality.preview_answer_attribution_agreement',
    title: 'Preview guest-answer reviewer agreement',
    description:
      'Compute a bounded, deterministic calibration report across independent human claim reviews of the same frozen guest answers. It reports coverage, support-label, and source-set agreement without deciding correctness, applying a threshold, or authorizing a release.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        limit: { type: 'integer', minimum: 2, maximum: 100, default: 100 },
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
    name: 'torchiko.knowledge.prepare_from_support',
    title: 'Prepare a client correction proposal',
    description:
      'Bind one exact in-review content-correction request version and its immutable messages to a separate knowledge proposal for human review. It never edits, publishes, retires, or re-embeds canonical venue knowledge and never contacts the customer.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        supportRequestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        evidenceMessageIds: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 120 },
        },
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
        'supportRequestId',
        'expectedVersion',
        'evidenceMessageIds',
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
    name: 'torchiko.knowledge.create_typed_draft',
    title: 'Create a typed draft from an approved proposal',
    description:
      'Create one append-only universal-content draft from an exact human-approved semantic proposal and preview. This never publishes, withdraws, or changes guest-visible knowledge.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        proposalId: { type: 'string', format: 'uuid' },
        expectedProposalUpdatedAt: { type: 'string', format: 'date-time' },
        expectedPreviewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        relation: { type: 'string', enum: ['NEW_FACT', 'CORRECTS', 'SUPERSEDES'] },
        desired: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'category', 'content', 'isEnabled'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            category: { type: 'string', minLength: 1, maxLength: 100 },
            content: { type: 'string', minLength: 1, maxLength: 5000 },
            isEnabled: { type: 'boolean' },
          },
        },
        draft: {
          type: 'object',
          additionalProperties: false,
          required: ['audience', 'evidence', 'payload'],
          properties: {
            audience: { type: 'string', enum: ['PUBLIC', 'CLIENT', 'OPERATOR'] },
            effectiveFrom: { type: ['string', 'null'], format: 'date-time' },
            effectiveUntil: { type: ['string', 'null'], format: 'date-time' },
            evidence: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sourceId', 'capturedAt'],
                properties: {
                  sourceId: { type: 'string', minLength: 1, maxLength: 500 },
                  locator: { type: 'string', minLength: 1, maxLength: 2000 },
                  capturedAt: { type: 'string', format: 'date-time' },
                  excerptHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
                },
              },
            },
            payload: {
              type: 'object',
              description:
                'A complete ITEM, SERVICE, POLICY, EVENT, OPERATIONAL_FACT, or RELATIONSHIP payload as defined by the universal-content contract.',
              required: ['kind'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['ITEM', 'SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP'],
                },
              },
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
        'proposalId',
        'expectedProposalUpdatedAt',
        'expectedPreviewHash',
        'relation',
        'desired',
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
    _meta: { 'com.pathfinder/security': security('venue', 'knowledge:draft', 'interaction') },
  },
  {
    name: 'torchiko.knowledge.adopt_legacy_draft',
    title: 'Adopt an exact legacy knowledge source as a native draft',
    description:
      'Create one native v1 draft and immutable source receipt for an exact unlinked legacy row targeted by a human-approved semantic proposal. The legacy row remains public until a separate approved publication action.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        proposalId: { type: 'string', format: 'uuid' },
        legacyKnowledgeEntryId: { type: 'string', minLength: 1, maxLength: 191 },
        expectedProposalUpdatedAt: { type: 'string', format: 'date-time' },
        expectedPreviewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedLegacyUpdatedAt: { type: 'string', format: 'date-time' },
        expectedLegacySnapshotHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        relation: { type: 'string', enum: ['CORRECTS', 'SUPERSEDES'] },
        desired: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'category', 'content', 'isEnabled'],
        },
        draft: {
          type: 'object',
          additionalProperties: false,
          required: ['audience', 'evidence', 'payload'],
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'proposalId',
        'legacyKnowledgeEntryId',
        'expectedProposalUpdatedAt',
        'expectedPreviewHash',
        'expectedLegacyUpdatedAt',
        'expectedLegacySnapshotHash',
        'relation',
        'desired',
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
    _meta: { 'com.pathfinder/security': security('venue', 'knowledge:draft', 'interaction') },
  },
  {
    name: 'pathfinder.propose_support_triage',
    title: 'Propose structured support triage',
    description:
      'Prepare one exact-version support category and missing-information recommendation for human review. This tool never mutates the request, changes client activity, contacts a customer, or authorizes execution.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        category: { type: 'string', enum: SupportRequestCategory.options },
        missingInformation: {
          type: 'array',
          maxItems: 30,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
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
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'category',
        'missingInformation',
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
    _meta: { 'com.pathfinder/security': security('venue', 'support:triage', 'interaction') },
  },
  {
    name: 'pathfinder.apply_support_triage',
    title: 'Apply approved support triage',
    description:
      'Apply the exact reviewed category and missing-information change to one unchanged support request under a one-shot approval grant. It cannot send messages, add participants, change status, execute work, or authorize later actions.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        category: { type: 'string', enum: SupportRequestCategory.options },
        missingInformation: {
          type: 'array',
          maxItems: 30,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'category',
        'missingInformation',
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
      'com.pathfinder/security': security('venue', 'support:triage', 'approved-transition'),
    },
  },
  {
    name: 'pathfinder.propose_support_information_request',
    title: 'Propose a client information request',
    description:
      'Prepare one exact-version, client-visible prompt using the request’s unchanged missing-information checklist. It creates a review item only and does not message the client, change status, or trigger external delivery.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        fromStatus: { type: 'string', enum: ['OPEN', 'IN_REVIEW'] },
        body: { type: 'string', minLength: 1, maxLength: 20_000 },
        missingInformation: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
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
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'fromStatus',
        'body',
        'missingInformation',
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
      'com.pathfinder/security': security('venue', 'support:request-information', 'interaction'),
    },
  },
  {
    name: 'pathfinder.apply_support_information_request',
    title: 'Send an approved in-app information request',
    description:
      'Create the exact reviewed in-app client-visible prompt and move one unchanged OPEN or IN_REVIEW request to WAITING_FOR_CLIENT under a one-shot grant. It cannot send email, add participants, alter triage, execute packages, or authorize later actions.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        fromStatus: { type: 'string', enum: ['OPEN', 'IN_REVIEW'] },
        body: { type: 'string', minLength: 1, maxLength: 20_000 },
        missingInformation: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'fromStatus',
        'body',
        'missingInformation',
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
      'com.pathfinder/security': security(
        'venue',
        'support:request-information',
        'approved-transition',
      ),
    },
  },
  {
    name: 'pathfinder.propose_support_completion',
    title: 'Propose support completion',
    description:
      'Prepare one exact-version, client-visible completion message after all requested information is resolved and every linked package is fully applied. It freezes exact package fulfillment, creates a review item only, and does not message the client, change status, or trigger external delivery.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        fromStatus: { type: 'string', enum: ['OPEN', 'IN_REVIEW'] },
        body: { type: 'string', minLength: 1, maxLength: 20_000 },
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
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'fromStatus',
        'body',
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
      'com.pathfinder/security': security('venue', 'support:complete', 'interaction'),
    },
  },
  {
    name: 'pathfinder.apply_support_completion',
    title: 'Apply an approved support completion',
    description:
      'Create the exact reviewed in-app completion message and move one unchanged OPEN or IN_REVIEW request with no missing information and unchanged fully applied package evidence to COMPLETED under a one-shot grant. It cannot send email, add participants, alter triage, execute packages, or authorize later actions.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        fromStatus: { type: 'string', enum: ['OPEN', 'IN_REVIEW'] },
        body: { type: 'string', minLength: 1, maxLength: 20_000 },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'fromStatus',
        'body',
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
      'com.pathfinder/security': security('venue', 'support:complete', 'approved-transition'),
    },
  },
  {
    name: 'pathfinder.propose_support_package_draft',
    title: 'Propose a granular support package draft',
    description:
      'Prepare one exact V3 package-patch payload and unchanged support-request version for human review. It creates no package, handoff, message, public change, or external delivery.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        fromStatus: { type: 'string', enum: ['OPEN', 'IN_REVIEW'] },
        draftKey: { type: 'string', format: 'uuid' },
        payload: { type: 'object', additionalProperties: true },
        operationCounts: {
          type: 'object',
          additionalProperties: false,
          required: [
            'venuePatch',
            'placeCreates',
            'placeUpdates',
            'placeDeletes',
            'knowledgeCreates',
            'knowledgeUpdates',
            'knowledgeDeletes',
            'total',
          ],
          properties: {
            venuePatch: { type: 'boolean' },
            placeCreates: { type: 'integer', minimum: 0 },
            placeUpdates: { type: 'integer', minimum: 0 },
            placeDeletes: { type: 'integer', minimum: 0 },
            knowledgeCreates: { type: 'integer', minimum: 0 },
            knowledgeUpdates: { type: 'integer', minimum: 0 },
            knowledgeDeletes: { type: 'integer', minimum: 0 },
            total: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
        evidence: {
          type: 'array',
          maxItems: 20,
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
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'fromStatus',
        'draftKey',
        'payload',
        'operationCounts',
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
    _meta: { 'com.pathfinder/security': security('venue', 'packages:draft', 'interaction') },
  },
  {
    name: 'pathfinder.apply_support_package_draft',
    title: 'Create an approved support package draft',
    description:
      'Create and link the exact reviewed V3 package as DRAFT under a one-shot grant. It cannot approve, apply, publish, or roll back the package; message the client; or alter request status or triage.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        fromStatus: { type: 'string', enum: ['OPEN', 'IN_REVIEW'] },
        draftKey: { type: 'string', format: 'uuid' },
        payload: { type: 'object', additionalProperties: true },
        operationCounts: {
          type: 'object',
          additionalProperties: false,
          required: [
            'venuePatch',
            'placeCreates',
            'placeUpdates',
            'placeDeletes',
            'knowledgeCreates',
            'knowledgeUpdates',
            'knowledgeDeletes',
            'total',
          ],
          properties: {
            venuePatch: { type: 'boolean' },
            placeCreates: { type: 'integer', minimum: 0 },
            placeUpdates: { type: 'integer', minimum: 0 },
            placeDeletes: { type: 'integer', minimum: 0 },
            knowledgeCreates: { type: 'integer', minimum: 0 },
            knowledgeUpdates: { type: 'integer', minimum: 0 },
            knowledgeDeletes: { type: 'integer', minimum: 0 },
            total: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'fromStatus',
        'draftKey',
        'payload',
        'operationCounts',
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
      'com.pathfinder/security': security('venue', 'packages:draft', 'approved-transition'),
    },
  },
  {
    name: 'pathfinder.propose_support_package_approval',
    title: 'Propose approval of a support-linked package',
    description:
      'Freeze one exact unchanged support-linked package DRAFT, its warning evidence, and bounded evaluation references for founder review. It does not approve, apply, publish, revert, contact a customer, or change support state.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        packageId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedUpdatedAt: { type: 'string', format: 'date-time' },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
        evidence: {
          type: 'array',
          maxItems: 20,
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
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'packageId',
        'expectedUpdatedAt',
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
    _meta: { 'com.pathfinder/security': security('venue', 'packages:approve', 'interaction') },
  },
  {
    name: 'pathfinder.apply_support_package_approval',
    title: 'Approve an exact support-linked package',
    description:
      'Move the exact reviewed support-linked package from DRAFT to APPROVED under one founder-issued one-shot grant. Applying, publishing, reverting, customer contact, and support-state mutation remain separate.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        packageId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedUpdatedAt: { type: 'string', format: 'date-time' },
        payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        baseDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        warningDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        supportHandoff: {
          type: 'object',
          additionalProperties: false,
          required: ['handoffId', 'supportRequestId', 'supportRequestVersion'],
          properties: {
            handoffId: { type: 'string', minLength: 1, maxLength: 191 },
            supportRequestId: { type: 'string', minLength: 1, maxLength: 191 },
            supportRequestVersion: { type: 'integer', minimum: 1 },
          },
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'packageId',
        'expectedUpdatedAt',
        'payloadHash',
        'baseDigest',
        'warningDigest',
        'supportHandoff',
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
      'com.pathfinder/security': security('venue', 'packages:approve', 'approved-transition'),
    },
  },
  {
    name: 'pathfinder.propose_support_package_application',
    title: 'Propose application of an approved support package',
    description:
      'Freeze one exact unchanged APPROVED support-linked package for founder review. Applying it mutates current venue content and may be visitor-visible; this proposal itself changes nothing.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        packageId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedUpdatedAt: { type: 'string', format: 'date-time' },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
        evidence: {
          type: 'array',
          maxItems: 20,
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
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'packageId',
        'expectedUpdatedAt',
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
    _meta: { 'com.pathfinder/security': security('venue', 'packages:apply', 'interaction') },
  },
  {
    name: 'pathfinder.apply_support_package_application',
    title: 'Apply an exact approved support package',
    description:
      'Under one founder-issued one-shot grant, apply the exact reviewed package to current venue content. The change may be visitor-visible. Support completion, customer contact, external delivery, and revert remain separate.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        packageId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedUpdatedAt: { type: 'string', format: 'date-time' },
        payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        baseDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        warningDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        approvedAt: { type: 'string', format: 'date-time' },
        approvedBy: { type: 'string', minLength: 1, maxLength: 191 },
        supportHandoff: {
          type: 'object',
          additionalProperties: false,
          required: ['handoffId', 'supportRequestId', 'supportRequestVersion'],
          properties: {
            handoffId: { type: 'string', minLength: 1, maxLength: 191 },
            supportRequestId: { type: 'string', minLength: 1, maxLength: 191 },
            supportRequestVersion: { type: 'integer', minimum: 1 },
          },
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'packageId',
        'expectedUpdatedAt',
        'payloadHash',
        'baseDigest',
        'warningDigest',
        'approvedAt',
        'approvedBy',
        'supportHandoff',
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
      'com.pathfinder/security': security('venue', 'packages:apply', 'approved-transition'),
    },
  },
  {
    name: 'pathfinder.propose_support_package_reversion',
    title: 'Propose reversion of an applied support package',
    description:
      'Freeze one exact unchanged APPLIED support-linked package and active support request for founder review. This proposal does not alter venue content.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        packageId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedUpdatedAt: { type: 'string', format: 'date-time' },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
        evidence: {
          type: 'array',
          maxItems: 20,
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
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'packageId',
        'expectedUpdatedAt',
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
    _meta: { 'com.pathfinder/security': security('venue', 'packages:revert', 'interaction') },
  },
  {
    name: 'pathfinder.apply_support_package_reversion',
    title: 'Revert an exact applied support package',
    description:
      'Under one founder-issued one-shot grant, invoke the canonical drift-checked rollback for the exact reviewed package. It never contacts the customer or changes support state.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        packageId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedUpdatedAt: { type: 'string', format: 'date-time' },
        payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        baseDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        rollbackManifestDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        appliedAt: { type: 'string', format: 'date-time' },
        appliedBy: { type: 'string', minLength: 1, maxLength: 191 },
        appliedCommandKey: { type: 'string', format: 'uuid' },
        supportHandoff: {
          type: 'object',
          additionalProperties: false,
          required: ['handoffId', 'supportRequestId', 'supportRequestVersion'],
          properties: {
            handoffId: { type: 'string', minLength: 1, maxLength: 191 },
            supportRequestId: { type: 'string', minLength: 1, maxLength: 191 },
            supportRequestVersion: { type: 'integer', minimum: 1 },
          },
        },
        supportRequestVersion: { type: 'integer', minimum: 1 },
        supportRequestStatus: { type: 'string', enum: ['OPEN', 'IN_REVIEW'] },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'packageId',
        'expectedUpdatedAt',
        'payloadHash',
        'baseDigest',
        'rollbackManifestDigest',
        'appliedAt',
        'appliedBy',
        'appliedCommandKey',
        'supportHandoff',
        'supportRequestVersion',
        'supportRequestStatus',
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
      'com.pathfinder/security': security('venue', 'packages:revert', 'approved-transition'),
    },
  },
  {
    name: 'pathfinder.propose_support_package_handoff_supersession',
    title: 'Propose replacement of a reverted support package handoff',
    description:
      'Freeze one exact unsuperseded REVERTED support package handoff and one separately linked APPLIED replacement for founder review. It changes no package or support state.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        supersededHandoffId: { type: 'string', minLength: 1, maxLength: 120 },
        replacementHandoffId: { type: 'string', minLength: 1, maxLength: 120 },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
        evidence: {
          type: 'array',
          maxItems: 20,
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
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'supersededHandoffId',
        'replacementHandoffId',
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
      'com.pathfinder/security': security('venue', 'packages:reconcile', 'interaction'),
    },
  },
  {
    name: 'pathfinder.apply_support_package_handoff_supersession',
    title: 'Record an applied replacement for a reverted support package',
    description:
      'Under one founder-issued one-shot grant, append current-truth supersession lineage while retaining both immutable handoffs. It changes no package content, support status, client activity, or message.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        supportRequestStatus: { type: 'string', enum: ['OPEN', 'IN_REVIEW'] },
        superseded: {
          type: 'object',
          additionalProperties: false,
          required: [
            'handoffId',
            'packageId',
            'handoffRequestVersion',
            'packageUpdatedAt',
            'payloadHash',
            'revertedAt',
            'revertedBy',
            'revertedCommandKey',
          ],
          properties: {
            handoffId: { type: 'string', minLength: 1, maxLength: 191 },
            packageId: { type: 'string', minLength: 1, maxLength: 191 },
            handoffRequestVersion: { type: 'integer', minimum: 1 },
            packageUpdatedAt: { type: 'string', format: 'date-time' },
            payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            revertedAt: { type: 'string', format: 'date-time' },
            revertedBy: { type: 'string', minLength: 1, maxLength: 191 },
            revertedCommandKey: { type: 'string', format: 'uuid' },
          },
        },
        replacement: {
          type: 'object',
          additionalProperties: false,
          required: [
            'handoffId',
            'packageId',
            'handoffRequestVersion',
            'packageUpdatedAt',
            'payloadHash',
            'appliedAt',
            'appliedBy',
            'appliedCommandKey',
          ],
          properties: {
            handoffId: { type: 'string', minLength: 1, maxLength: 191 },
            packageId: { type: 'string', minLength: 1, maxLength: 191 },
            handoffRequestVersion: { type: 'integer', minimum: 1 },
            packageUpdatedAt: { type: 'string', format: 'date-time' },
            payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            appliedAt: { type: 'string', format: 'date-time' },
            appliedBy: { type: 'string', minLength: 1, maxLength: 191 },
            appliedCommandKey: { type: 'string', format: 'uuid' },
          },
        },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'supportRequestStatus',
        'superseded',
        'replacement',
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
      'com.pathfinder/security': security('venue', 'packages:reconcile', 'approved-transition'),
    },
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
        generalization: {
          ...strictObject(
            {
              rationale: { type: 'string', minLength: 10, maxLength: 2000 },
              counterexampleObservationIds: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                uniqueItems: true,
                items: { type: 'string', minLength: 1, maxLength: 120 },
              },
              exclusions: {
                type: 'array',
                minItems: 1,
                maxItems: 10,
                items: { type: 'string', minLength: 1, maxLength: 500 },
              },
            },
            ['rationale', 'counterexampleObservationIds', 'exclusions'],
          ),
          description:
            'Required when selected outcome evidence has question provenance. Counterexamples must be selected same-scope observations distinct from source-linked mixed or negative corrections.',
        },
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
    name: 'torchiko.agent_workflows.get_compatible_versions',
    title: 'Read scoped registered workflow versions',
    description:
      'Inspect the latest registered version of up to five named workflows or skills and current tool compatibility. Returned text is an unactivated artifact, not execution authority.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        registryKeys: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'string', minLength: 1, maxLength: 191 },
        },
      },
      [...scopeRequired, 'registryKeys'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'resources:read', 'read') },
  },
  {
    name: 'torchiko.agent_workflows.register_version',
    title: 'Register an unactivated portable workflow version',
    description:
      'Store one immutable portable skill or workflow version with declared provenance and current tool compatibility. Registration grants no activation authority.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        manifest: { type: 'object' },
        portableText: { type: 'string', minLength: 1, maxLength: 50000 },
        provenance: { type: 'object' },
        supersedesVersionId: { type: 'string', format: 'uuid' },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'manifest',
        'portableText',
        'provenance',
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
          description:
            'Required for agent-run-trace, agent-run-result, question-source, and assigned-source.',
        },
        questionId: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Required only for question-source.',
        },
        artifactIndex: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'Optional zero-based whole-artifact selection for agent-run-result.',
        },
        artifactOffset: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'Optional UTF-8 byte offset for chunked agent-run-result artifact reads.',
        },
        cursor: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        sourceCursor: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description: 'Question-source page cursor. It is separate from generic resource cursors.',
        },
        pageSize: {
          type: 'integer',
          minimum: 1,
          maximum: 4000,
          description:
            'Optional maximum character count for a question-source or assigned-source page.',
        },
        search: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Optional bounded search text for question-source or assigned-source.',
        },
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
    inputSchema: {
      ...strictObject(
        {
          ...scopeProperties,
          operationId: { type: 'string', format: 'uuid' },
          agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
          agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
          question: { type: 'string', minLength: 1, maxLength: 2000 },
          context: { type: 'string', minLength: 1, maxLength: 2000 },
          expiresAt: {
            type: 'string',
            format: 'date-time',
            description:
              'Optional explicit response cutoff. Omit to keep the question open without automatic expiry.',
          },
          choices: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 200 },
          },
          blocking: {
            type: 'boolean',
            description:
              'Generic questions only; source questions derive blocking from blockerScope.',
          },
          sourceClarification: strictObject(
            {
              runId: { type: 'string', minLength: 1, maxLength: 191 },
              receiptId: { type: 'string', format: 'uuid' },
              expectedExtractedTextHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              fieldPath: { type: 'string', minLength: 1, maxLength: 500 },
              reason: {
                type: 'string',
                enum: ['CONTRADICTION', 'DATE_SENSITIVE', 'LOW_CONFIDENCE', 'MISSING_CONTEXT'],
              },
              blockerScope: { type: 'string', enum: ['LOCAL', 'FOUNDATIONAL'] },
              evidenceExcerpt: { type: 'string', minLength: 1, maxLength: 1000 },
            },
            [
              'runId',
              'receiptId',
              'expectedExtractedTextHash',
              'fieldPath',
              'reason',
              'blockerScope',
              'evidenceExcerpt',
            ],
          ),
        },
        [...scopeRequired, 'agentIdentityId', 'question'],
      ),
      oneOf: [
        { required: ['operationId'], not: { required: ['sourceClarification'] } },
        {
          required: ['sourceClarification', 'agentRunId'],
          not: {
            anyOf: ['operationId', 'context', 'choices', 'expiresAt', 'blocking'].map((key) => ({
              required: [key],
            })),
          },
        },
      ],
    },
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
        executionLeaseToken: {
          type: 'string',
          format: 'uuid',
          description:
            'Exact current parent-run lease token required for workflow-bound delegation.',
        },
        waitForResult: {
          type: 'boolean',
          default: false,
          description:
            'Pause the current parent lease until this exact child reaches a terminal state.',
        },
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
    name: 'pathfinder.propose_intake_v1_package_draft',
    title: 'Propose an exact V1 package draft',
    description:
      'Request human approval for one exact server-derived V1 package candidate. No package or public change is created.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        executionLeaseToken: { type: 'string', format: 'uuid' },
        submissionId: { type: 'string', minLength: 1, maxLength: 120 },
        revision: { type: 'integer', minimum: 1 },
        selectedMemberIds: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 120 },
        },
        expectedManifestHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedCandidateHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedPayloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedSelectionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        partialAcknowledged: { type: 'boolean' },
        draftOperationId: { type: 'string', format: 'uuid' },
        reason: { type: 'string', minLength: 3, maxLength: 2000 },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'executionLeaseToken',
        'submissionId',
        'revision',
        'selectedMemberIds',
        'expectedManifestHash',
        'expectedCandidateHash',
        'expectedPayloadHash',
        'expectedSelectionHash',
        'partialAcknowledged',
        'draftOperationId',
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
    _meta: { 'com.pathfinder/security': security('venue', 'packages:draft', 'interaction') },
  },
  {
    name: 'pathfinder.apply_intake_v1_package_draft',
    title: 'Create an approved exact V1 package draft',
    description:
      'Consume one exact human approval to create one inactive package DRAFT and V1 handoff. It cannot approve, apply, or publish.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        executionLeaseToken: { type: 'string', format: 'uuid' },
        submissionId: { type: 'string', minLength: 1, maxLength: 120 },
        revision: { type: 'integer', minimum: 1 },
        selectedMemberIds: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 120 },
        },
        expectedManifestHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedCandidateHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedPayloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedSelectionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        partialAcknowledged: { type: 'boolean' },
        draftOperationId: { type: 'string', format: 'uuid' },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'executionLeaseToken',
        'submissionId',
        'revision',
        'selectedMemberIds',
        'expectedManifestHash',
        'expectedCandidateHash',
        'expectedPayloadHash',
        'expectedSelectionHash',
        'partialAcknowledged',
        'draftOperationId',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'packages:draft', 'draft') },
  },
  {
    name: 'pathfinder.preview_intake_v1_package_draft',
    title: 'Preview an exact V1 intake package',
    description:
      'Build a bounded, server-derived preview for an exact submitted V1 revision and member selection. This read-only tool creates no package, handoff, approval, application, or publication.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        submissionId: { type: 'string', minLength: 1, maxLength: 120 },
        revision: { type: 'integer', minimum: 1 },
        selectedMemberIds: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      [...scopeRequired, 'submissionId', 'revision', 'selectedMemberIds'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'packages:read', 'read') },
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
        executionLeaseToken: {
          type: 'string',
          format: 'uuid',
          description:
            'Caller-held execution lease from the run claim; required for workflow-bound runs.',
        },
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
        executionLeaseToken: {
          type: 'string',
          format: 'uuid',
          description:
            'Caller-held execution lease from the run claim; required for workflow-bound runs.',
        },
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
    name: 'pathfinder.open_support_request',
    title: 'Open an internal support draft',
    description:
      'Promote one existing internal support request from DRAFT to OPEN under exact approval. It cannot add participants, send messages, contact a customer, or perform later workflow transitions.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
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
      'com.pathfinder/security': security('venue', 'support:open', 'approved-transition'),
    },
  },
  {
    name: 'pathfinder.add_support_internal_note',
    title: 'Add an internal support note',
    description:
      'Append one attachment-free INTERNAL_ONLY note to an existing nonclosed support request under exact approval. It cannot contact a customer, add participants, change lifecycle state or triage, or make the note client-visible.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        operationId: { type: 'string', format: 'uuid' },
        agentIdentityId: { type: 'string', minLength: 1, maxLength: 120 },
        agentRunId: { type: 'string', minLength: 1, maxLength: 120 },
        workerKey: { type: 'string', minLength: 1, maxLength: 120 },
        executionLeaseToken: {
          type: 'string',
          format: 'uuid',
          description:
            'Caller-held execution lease from the run claim; required for workflow-bound runs.',
        },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        expectedVersion: { type: 'integer', minimum: 1 },
        body: { type: 'string', minLength: 1, maxLength: 20000 },
      },
      [
        ...scopeRequired,
        'operationId',
        'agentIdentityId',
        'agentRunId',
        'workerKey',
        'requestId',
        'expectedVersion',
        'body',
      ],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'support:note', 'draft') },
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
      (metadata.effect === 'draft' ||
        metadata.effect === 'approved-transition' ||
        metadata.effect === 'bounded-evaluation-request') &&
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
