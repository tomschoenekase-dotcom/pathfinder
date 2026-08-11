import { z } from 'zod'

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
  'readiness:read',
  'packages:draft',
  'support:draft',
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
  effect: 'read' | 'draft' | 'bounded-evaluation-request'
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
  return {
    scope,
    capability,
    tenantBound: true,
    clientBound: true,
    venueBound: scope === 'client-or-venue' ? 'conditional' : scope === 'venue',
    risk: readOnly ? 'low' : 'moderate',
    effect,
    defaultEnabled: readOnly,
    approvalRequired: !readOnly,
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
    'Bounded venue AI cost, token, and latency summaries.',
    'pathfinder://clients/{clientId}/venues/{venueId}/ai-usage',
    'venue',
    'ai-usage:read',
  ],
  [
    'jobs',
    'Jobs',
    'Venue-scoped background job status and failures.',
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
    'readiness',
    'Venue readiness',
    'Onboarding, preview, and launch-readiness evidence.',
    'pathfinder://clients/{clientId}/venues/{venueId}/readiness',
    'venue',
    'readiness:read',
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
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict()
export type McpReadInput = z.infer<typeof McpReadInput>

export const McpPackageDraftInput = McpRequestedScope.extend({
  title: z.string().trim().min(1).max(160),
  changeRequest: z.string().trim().min(1).max(10_000),
  sourceIds: z.array(Identifier).max(100).default([]),
}).strict()
export type McpPackageDraftInput = z.infer<typeof McpPackageDraftInput>

export const McpUpdateDraftInput = McpRequestedScope.extend({
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

export const McpToolResult = z
  .object({ kind: Identifier, summary: Summary, data: JsonValue })
  .strict()
export type McpToolResult = z.infer<typeof McpToolResult>

export type PathfinderMcpToolName =
  | 'pathfinder.read'
  | 'pathfinder.create_package_draft'
  | 'pathfinder.create_update_draft'
  | 'pathfinder.create_support_draft'
  | 'pathfinder.request_evaluation'

export const PATHFINDER_MCP_TOOLS: readonly PathfinderMcpToolDefinition[] = [
  {
    name: 'pathfinder.read',
    title: 'Read PathFinder data',
    description:
      'Read an authorized client or venue resource. Tenant authority comes only from the verified credential.',
    inputSchema: strictObject(
      {
        ...scopeProperties,
        resource: { type: 'string', enum: resourceSeeds.map(([name]) => name) },
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
        title: { type: 'string', minLength: 1, maxLength: 160 },
        body: { type: 'string', minLength: 1, maxLength: 4000 },
        startsAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
      [...scopeRequired, 'title', 'body', 'startsAt', 'expiresAt'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
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
      [...scopeRequired, 'subject', 'body', 'category'],
    ),
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: { 'com.pathfinder/security': security('venue', 'support:draft', 'draft') },
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
    if (metadata.effect !== 'read' && (metadata.defaultEnabled || !metadata.approvalRequired)) {
      throw new Error(`Tool ${tool.name} must remain default-off and approval-gated`)
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
