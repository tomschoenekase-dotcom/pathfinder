import { z } from 'zod'

import { McpAppearanceUpdateInput, type JsonSchema } from './mcp-v0'
import { SupportRequestStatus } from './support-workflow'

/**
 * Contract-only catalog for the Dot operator surface (plain dotted tool names, no product prefix).
 * It provides no transport, authentication, or data access. Every write tool only creates a
 * proposal; a human (or a server-side autonomy policy the operator cannot read or write) decides
 * whether it applies. There is no tool that sends email, charges money, deletes data, or writes
 * autonomy policy. `operator.get_autonomy` is a read-only view of the policy.
 */
export const OPERATOR_MCP_CATALOG_VERSION = 'torchiko-operator-mcp-v0' as const

// ---------------------------------------------------------------------------
// Shared value shapes
// ---------------------------------------------------------------------------

const Identifier = z.string().trim().min(1).max(120)
const Cursor = z.string().trim().min(1).max(500)
const OperationId = z.string().uuid()
const IsoDateTime = z.string().datetime({ offset: true })
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u)
const PageLimit = z.number().int().min(1).max(25).default(25)
const Email = z.string().trim().toLowerCase().email().max(254)
const HttpsUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .regex(/^https:\/\//u)
const Slug = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*$/u)

export const ProspectStageValue = z.enum([
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
export const OperatorSupportPriority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
export const OperatorInviteRole = z.enum(['MEMBER'])

/** Retrieved free text (notes, messages, source excerpts). Always data, never instructions. */
export const UntrustedText = z
  .object({
    untrusted: z.literal(true),
    text: z.string().max(20_000),
    truncated: z.boolean(),
  })
  .strict()
export type UntrustedText = z.infer<typeof UntrustedText>

export const OperatorProposalStatus = z.enum([
  'PENDING',
  'APPROVED',
  'APPLIED',
  'FAILED',
  'STALE',
  'REJECTED',
  'EXPIRED',
])
export type OperatorProposalStatus = z.infer<typeof OperatorProposalStatus>

/** Returned by every write tool. Show `approveUrl` to the human when status is PENDING. */
export const OperatorWriteResult = z
  .object({
    proposalId: Identifier,
    status: OperatorProposalStatus,
    argsHash: Sha256Hex,
    approveUrl: z.string().url().max(2000).optional(),
    result: z.record(z.unknown()).optional(),
  })
  .strict()
export type OperatorWriteResult = z.infer<typeof OperatorWriteResult>

export const OperatorCapability = z.enum([
  'crm:read',
  'crm:propose',
  'crm:log',
  'venues:read',
  'venues:propose',
  'appearance:read',
  'appearance:propose',
  'customers:propose',
  'support:read',
  'support:propose',
  'operator:read',
  'operator:plan',
  'operator:revert',
])
export type OperatorCapability = z.infer<typeof OperatorCapability>

export const OperatorToolScope = z.enum(['platform', 'tenant', 'venue'])
export type OperatorToolScope = z.infer<typeof OperatorToolScope>

/** Tools that always wait for a human, whatever the autonomy policy says. */
export const OPERATOR_ALWAYS_ASK_TOOLS = [
  'customers.propose_invite',
  'operator.propose_revert',
] as const

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const OPERATOR_READ_TOOL_NAMES = [
  'crm.search_organizations',
  'crm.get_organization',
  'crm.list_candidates',
  'crm.get_contact_history',
  'crm.check_can_contact',
  'venues.list',
  'venues.get_readiness',
  'appearance.get',
  'support.list',
  'operator.get_manual',
  'operator.get_proposal',
  'operator.list_proposals',
  'operator.get_autonomy',
] as const

export const OPERATOR_WRITE_TOOL_NAMES = [
  'crm.propose_campaign_membership',
  'crm.propose_outreach_draft',
  'crm.propose_stage_change',
  'crm.log_outreach_sent',
  'venues.propose_create',
  'venues.propose_source',
  'venues.propose_knowledge',
  'venues.propose_publish',
  'appearance.propose_update',
  'customers.propose_invite',
  'support.propose_triage',
  'operator.propose_plan',
  'operator.propose_revert',
] as const

export type OperatorReadToolName = (typeof OPERATOR_READ_TOOL_NAMES)[number]
export type OperatorWriteToolName = (typeof OPERATOR_WRITE_TOOL_NAMES)[number]
export type OperatorToolName = OperatorReadToolName | OperatorWriteToolName
export type OperatorPlanStepToolName = Exclude<
  OperatorWriteToolName,
  'operator.propose_plan' | 'operator.propose_revert'
>

/** Plan steps may run any write tool except plans and reverts (no nesting, no bulk revert). */
export const OPERATOR_PLAN_STEP_TOOLS = OPERATOR_WRITE_TOOL_NAMES.filter(
  (name) => name !== 'operator.propose_plan' && name !== 'operator.propose_revert',
) as unknown as readonly [OperatorPlanStepToolName, ...OperatorPlanStepToolName[]]

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const readInput = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()
const writeInput = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, operationId: OperationId }).strict()

const tenantScope = { tenantId: Identifier } as const
const venueScope = { tenantId: Identifier, venueId: Identifier } as const

const OrganizationFilters = {
  city: z.string().trim().min(1).max(120).optional(),
  region: z.string().trim().min(1).max(120).optional(),
  type: z.string().trim().min(1).max(80).optional(),
} as const

/**
 * A plan groups ordered write steps under one approval. A step's `arguments` may reference the
 * output of an earlier step with a string of the form "{{steps.N.result.<field>}}" (N is the
 * zero-based index of an earlier step). The server resolves these at apply time; this contract
 * does not evaluate them.
 */
export const OperatorPlanStep = z
  .object({
    tool: z.enum(OPERATOR_PLAN_STEP_TOOLS),
    arguments: z.record(z.unknown()),
    dependsOn: z.array(z.number().int().min(0).max(11)).max(11).optional(),
  })
  .strict()
export type OperatorPlanStep = z.infer<typeof OperatorPlanStep>

const OperatorPlanInput = writeInput({
  title: z.string().trim().min(1).max(200),
  steps: z.array(OperatorPlanStep).min(1).max(12),
}).superRefine((value, ctx) => {
  value.steps.forEach((step, index) => {
    const seen = new Set<number>()
    for (const dependency of step.dependsOn ?? []) {
      if (dependency >= index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dependsOn must reference an earlier step',
          path: ['steps', index, 'dependsOn'],
        })
      }
      if (seen.has(dependency)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dependsOn entries must be unique',
          path: ['steps', index, 'dependsOn'],
        })
      }
      seen.add(dependency)
    }
  })
})

/** Same appearance fields as Release B's McpAppearanceUpdateInput, scoped by tenantId. */
const appearanceUpdateBase = McpAppearanceUpdateInput.innerType().innerType()
const AppearanceProposeInput = appearanceUpdateBase
  .omit({ clientId: true })
  .extend({ tenantId: Identifier })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.chatTheme !== undefined ||
      value.chatAccentColor !== undefined ||
      value.chatFont !== undefined ||
      value.chatAppearance !== undefined,
    { message: 'At least one appearance field must be provided' },
  )
  .refine((value) => !(value.title !== undefined && value.chatAppearance === null), {
    message: 'title cannot be combined with clearing chatAppearance',
    path: ['chatAppearance'],
  })

export const OPERATOR_MCP_INPUTS = {
  'crm.search_organizations': readInput({
    query: z.string().trim().min(1).max(200),
    ...OrganizationFilters,
    cursor: Cursor.optional(),
    limit: PageLimit,
  }),
  'crm.get_organization': readInput({ organizationId: Identifier }),
  'crm.list_candidates': readInput({
    ...OrganizationFilters,
    size: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
    uncontacted: z.boolean().optional(),
    cursor: Cursor.optional(),
    limit: PageLimit,
  }),
  'crm.get_contact_history': readInput({ organizationId: Identifier }),
  'crm.check_can_contact': readInput({ email: Email }),
  'venues.list': readInput({ ...tenantScope, cursor: Cursor.optional() }),
  'venues.get_readiness': readInput({ ...venueScope }),
  'appearance.get': readInput({ ...venueScope }),
  'support.list': readInput({
    ...tenantScope,
    venueId: Identifier.optional(),
    status: SupportRequestStatus.optional(),
    cursor: Cursor.optional(),
  }),
  'operator.get_manual': readInput({}),
  'operator.get_proposal': readInput({ proposalId: Identifier }),
  'operator.list_proposals': readInput({
    status: OperatorProposalStatus.optional(),
    cursor: Cursor.optional(),
  }),
  'operator.get_autonomy': readInput({}),

  'crm.propose_campaign_membership': writeInput({
    organizationId: Identifier,
    campaignId: Identifier,
  }),
  'crm.propose_outreach_draft': writeInput({
    campaignMemberId: Identifier,
    subject: z.string().trim().min(1).max(200),
    textBody: z.string().trim().min(1).max(8_000),
  }),
  'crm.propose_stage_change': writeInput({
    organizationId: Identifier,
    expectedVersion: z.number().int().positive(),
    stage: ProspectStageValue,
  }),
  'crm.log_outreach_sent': writeInput({
    organizationId: Identifier,
    contactId: Identifier,
    gmailMessageId: z.string().trim().min(1).max(200),
    sentAt: IsoDateTime,
  }),
  'venues.propose_create': writeInput({
    ...tenantScope,
    name: z.string().trim().min(1).max(120),
    slug: Slug.optional(),
    city: z.string().trim().min(1).max(120).optional(),
    region: z.string().trim().min(1).max(120).optional(),
  }),
  'venues.propose_source': writeInput({
    ...venueScope,
    url: HttpsUrl,
    note: z.string().trim().min(1).max(500).optional(),
  }),
  'venues.propose_knowledge': writeInput({
    ...venueScope,
    entries: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            body: z.string().trim().min(1).max(4_000),
            category: z.string().trim().min(1).max(80).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  }),
  'venues.propose_publish': writeInput({ ...venueScope, expectedUpdatedAt: IsoDateTime }),
  'appearance.propose_update': AppearanceProposeInput,
  'customers.propose_invite': writeInput({
    ...tenantScope,
    email: Email,
    role: OperatorInviteRole,
  }),
  'support.propose_triage': writeInput({
    ...venueScope,
    requestId: Identifier,
    expectedUpdatedAt: IsoDateTime,
    status: SupportRequestStatus,
    priority: OperatorSupportPriority,
    note: z.string().trim().min(1).max(2_000).optional(),
  }),
  'operator.propose_plan': OperatorPlanInput,
  'operator.propose_revert': writeInput({ proposalId: Identifier }),
} as const satisfies Record<OperatorToolName, z.ZodTypeAny>

export type OperatorToolInput<T extends OperatorToolName> = z.input<(typeof OPERATOR_MCP_INPUTS)[T]>

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item).max(25), nextCursor: z.string().max(500).nullable() }).strict()

const ContactFlags = z
  .object({
    doNotContact: z.boolean(),
    suppressed: z.boolean(),
    unsubscribed: z.boolean(),
    complained: z.boolean(),
  })
  .strict()

/** `email` is non-null only when the contact is contactable. */
const OperatorContact = z
  .object({
    contactId: Identifier,
    displayName: z.string().max(200).nullable(),
    role: z.string().max(200).nullable(),
    contactable: z.boolean(),
    flags: ContactFlags,
    email: z.string().max(254).nullable(),
  })
  .strict()

const OperatorOrganization = z
  .object({
    organizationId: Identifier,
    name: z.string().max(200),
    type: z.string().max(80).nullable(),
    city: z.string().max(120).nullable(),
    region: z.string().max(120).nullable(),
    stage: ProspectStageValue,
    version: z.number().int().nonnegative(),
    sizeClass: z.string().max(10).nullable(),
    contacted: z.boolean(),
  })
  .strict()

const OperatorProposalView = z
  .object({
    proposalId: Identifier,
    tool: z.string().max(80),
    kind: z.string().max(80),
    status: OperatorProposalStatus,
    argsHash: Sha256Hex,
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
    approveUrl: z.string().url().max(2000).optional(),
    result: z.record(z.unknown()).optional(),
  })
  .strict()

export const OPERATOR_MCP_OUTPUTS = {
  'crm.search_organizations': Page(OperatorOrganization),
  'crm.get_organization': z
    .object({
      organization: OperatorOrganization,
      contacts: z.array(OperatorContact).max(50),
      notes: z.array(UntrustedText).max(20),
    })
    .strict(),
  'crm.list_candidates': Page(OperatorOrganization),
  'crm.get_contact_history': z
    .object({
      organizationId: Identifier,
      events: z
        .array(
          z
            .object({
              type: z.string().max(80),
              occurredAt: IsoDateTime,
              summary: UntrustedText,
            })
            .strict(),
        )
        .max(200),
    })
    .strict(),
  'crm.check_can_contact': z
    .object({
      allowed: z.boolean(),
      reason: z.enum([
        'ok',
        'unknown_address',
        'do_not_contact',
        'suppressed',
        'unsubscribed',
        'complained',
      ]),
      organizationId: Identifier.nullable(),
      contactId: Identifier.nullable(),
    })
    .strict(),
  'venues.list': Page(
    z
      .object({
        venueId: Identifier,
        tenantId: Identifier,
        name: z.string().max(120),
        slug: z.string().max(200),
        status: z.string().max(40),
        updatedAt: IsoDateTime,
      })
      .strict(),
  ),
  'venues.get_readiness': z
    .object({
      venueId: Identifier,
      ready: z.boolean(),
      checks: z
        .array(
          z
            .object({ key: z.string().max(80), passed: z.boolean(), detail: z.string().max(500) })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  'appearance.get': z
    .object({
      venueId: Identifier,
      updatedAt: IsoDateTime,
      title: z.string().max(80).nullable(),
      chatTheme: z.string().max(40),
      chatAccentColor: z.string().max(7).nullable(),
      chatFont: z.string().max(40),
      chatAppearance: z.record(z.unknown()).nullable(),
    })
    .strict(),
  'support.list': Page(
    z
      .object({
        requestId: Identifier,
        venueId: Identifier,
        status: SupportRequestStatus,
        priority: OperatorSupportPriority,
        updatedAt: IsoDateTime,
        subject: UntrustedText,
      })
      .strict(),
  ),
  'operator.get_manual': z
    .object({ version: z.string().max(40), text: z.string().max(40_000) })
    .strict(),
  'operator.get_proposal': OperatorProposalView,
  'operator.list_proposals': Page(OperatorProposalView),
  'operator.get_autonomy': z
    .object({
      policies: z
        .array(
          z
            .object({
              capability: OperatorCapability,
              mode: z.enum(['ask', 'auto']),
              locked: z.boolean(),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),

  'crm.propose_campaign_membership': OperatorWriteResult,
  'crm.propose_outreach_draft': OperatorWriteResult,
  'crm.propose_stage_change': OperatorWriteResult,
  'crm.log_outreach_sent': OperatorWriteResult,
  'venues.propose_create': OperatorWriteResult,
  'venues.propose_source': OperatorWriteResult,
  'venues.propose_knowledge': OperatorWriteResult,
  'venues.propose_publish': OperatorWriteResult,
  'appearance.propose_update': OperatorWriteResult,
  'customers.propose_invite': OperatorWriteResult,
  'support.propose_triage': OperatorWriteResult,
  'operator.propose_plan': OperatorWriteResult,
  'operator.propose_revert': OperatorWriteResult,
} as const satisfies Record<OperatorToolName, z.ZodTypeAny>

// ---------------------------------------------------------------------------
// Minimal zod -> JSON Schema converter (only the constructs used in this file)
// ---------------------------------------------------------------------------

type ZodDefLike = { typeName: string } & Record<string, unknown>

function unwrapEffects(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema
  while ((current._def as ZodDefLike).typeName === 'ZodEffects') {
    current = (current._def as unknown as { schema: z.ZodTypeAny }).schema
  }
  return current
}

function toJsonSchema(input: z.ZodTypeAny): Record<string, unknown> {
  const schema = unwrapEffects(input)
  const def = schema._def as ZodDefLike
  switch (def.typeName) {
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' }
      for (const check of (def.checks ?? []) as Array<{
        kind: string
        value?: number
        regex?: RegExp
      }>) {
        if (check.kind === 'min') out.minLength = check.value
        else if (check.kind === 'max') out.maxLength = check.value
        else if (check.kind === 'uuid') out.format = 'uuid'
        else if (check.kind === 'email') out.format = 'email'
        else if (check.kind === 'url') out.format = 'uri'
        else if (check.kind === 'datetime') out.format = 'date-time'
        else if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source
      }
      return out
    }
    case 'ZodNumber': {
      const out: Record<string, unknown> = { type: 'number' }
      for (const check of (def.checks ?? []) as Array<{
        kind: string
        value?: number
        inclusive?: boolean
      }>) {
        if (check.kind === 'int') out.type = 'integer'
        else if (check.kind === 'min') {
          out[check.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = check.value
        } else if (check.kind === 'max') {
          out[check.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = check.value
        }
      }
      return out
    }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodLiteral':
      return { const: def.value }
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])] }
    case 'ZodUnknown':
      return {}
    case 'ZodOptional':
      return toJsonSchema(def.innerType as z.ZodTypeAny)
    case 'ZodNullable':
      return { anyOf: [toJsonSchema(def.innerType as z.ZodTypeAny), { type: 'null' }] }
    case 'ZodDefault':
      return {
        ...toJsonSchema(def.innerType as z.ZodTypeAny),
        default: (def.defaultValue as () => unknown)(),
      }
    case 'ZodArray': {
      const out: Record<string, unknown> = {
        type: 'array',
        items: toJsonSchema(def.type as z.ZodTypeAny),
      }
      const min = def.minLength as { value: number } | null
      const max = def.maxLength as { value: number } | null
      if (min) out.minItems = min.value
      if (max) out.maxItems = max.value
      return out
    }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: toJsonSchema(def.valueType as z.ZodTypeAny) }
    case 'ZodObject': {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value)
        if (!value.isOptional()) required.push(key)
      }
      return { type: 'object', properties, required, additionalProperties: false }
    }
    default:
      throw new Error(`operator-mcp: unsupported zod type ${def.typeName}`)
  }
}

const rootSchema = (schema: z.ZodTypeAny): JsonSchema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...toJsonSchema(schema),
})

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export type OperatorToolEffect = 'read' | 'proposal'

export type OperatorToolDefinition = Readonly<{
  name: OperatorToolName
  title: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  annotations: Readonly<{
    readOnlyHint: boolean
    destructiveHint: false
    idempotentHint: true
    openWorldHint: false
  }>
  capability: OperatorCapability
  effect: OperatorToolEffect
  /** Present on proposal tools only: the server-side proposal kind this tool creates. */
  proposalKind?: string
  scope: OperatorToolScope
}>

type Seed = readonly [
  name: OperatorToolName,
  title: string,
  description: string,
  capability: OperatorCapability,
  scope: OperatorToolScope,
  proposalKind?: string,
]

const READ = ' Read-only.'
const PROPOSE =
  ' Creates a proposal; check status and show the approveUrl to the human when it is PENDING.'

const seeds: readonly Seed[] = [
  [
    'crm.search_organizations',
    'Search organizations',
    `Search prospect organizations by text and filters.${READ}`,
    'crm:read',
    'platform',
  ],
  [
    'crm.get_organization',
    'Get organization',
    `Read one organization with its contacts (addresses only for contactable people) and notes.${READ}`,
    'crm:read',
    'platform',
  ],
  [
    'crm.list_candidates',
    'List outreach candidates',
    `List organizations that are candidates for outreach, optionally only never-contacted ones.${READ}`,
    'crm:read',
    'platform',
  ],
  [
    'crm.get_contact_history',
    'Get contact history',
    `Read the outreach and activity history for one organization.${READ}`,
    'crm:read',
    'platform',
  ],
  [
    'crm.check_can_contact',
    'Check can contact',
    `Check whether an address may be emailed. Required immediately before every send.${READ}`,
    'crm:read',
    'platform',
  ],
  ['venues.list', 'List venues', `List venues in one tenant.${READ}`, 'venues:read', 'tenant'],
  [
    'venues.get_readiness',
    'Get venue readiness',
    `Read launch readiness checks for one venue.${READ}`,
    'venues:read',
    'venue',
  ],
  [
    'appearance.get',
    'Get venue appearance',
    `Read visitor chat appearance settings and the updatedAt needed to propose a change.${READ}`,
    'appearance:read',
    'venue',
  ],
  [
    'support.list',
    'List support requests',
    `List support requests for a tenant or venue.${READ}`,
    'support:read',
    'tenant',
  ],
  [
    'operator.get_manual',
    'Get operator manual',
    `Read the operating manual for this tool surface.${READ}`,
    'operator:read',
    'platform',
  ],
  [
    'operator.get_proposal',
    'Get proposal',
    `Read the current status and outcome of one proposal.${READ}`,
    'operator:read',
    'platform',
  ],
  [
    'operator.list_proposals',
    'List proposals',
    `List proposals, optionally by status.${READ}`,
    'operator:read',
    'platform',
  ],
  [
    'operator.get_autonomy',
    'Get autonomy policy',
    `View which capabilities need human approval. Cannot change the policy.${READ}`,
    'operator:read',
    'platform',
  ],

  [
    'crm.propose_campaign_membership',
    'Propose campaign membership',
    `Propose adding an organization to a campaign.${PROPOSE}`,
    'crm:propose',
    'platform',
    'crm.campaign-membership',
  ],
  [
    'crm.propose_outreach_draft',
    'Propose outreach draft',
    `Propose a saved outreach draft for review. Does not contact anyone.${PROPOSE}`,
    'crm:propose',
    'platform',
    'crm.outreach-draft',
  ],
  [
    'crm.propose_stage_change',
    'Propose stage change',
    `Propose moving an organization to another pipeline stage.${PROPOSE}`,
    'crm:propose',
    'platform',
    'crm.stage-change',
  ],
  [
    'crm.log_outreach_sent',
    'Log outreach sent',
    `Record in CRM history that an email went out from Gmail. Call after every such email.${PROPOSE}`,
    'crm:log',
    'platform',
    'crm.outreach-log',
  ],
  [
    'venues.propose_create',
    'Propose venue creation',
    `Propose creating a draft venue in a tenant.${PROPOSE}`,
    'venues:propose',
    'tenant',
    'venues.create',
  ],
  [
    'venues.propose_source',
    'Propose venue source',
    `Propose adding a public https source URL to a venue.${PROPOSE}`,
    'venues:propose',
    'venue',
    'venues.source',
  ],
  [
    'venues.propose_knowledge',
    'Propose venue knowledge',
    `Propose knowledge entries for a venue.${PROPOSE}`,
    'venues:propose',
    'venue',
    'venues.knowledge',
  ],
  [
    'venues.propose_publish',
    'Propose venue publish',
    `Propose publishing a venue at the observed updatedAt.${PROPOSE}`,
    'venues:propose',
    'venue',
    'venues.publish',
  ],
  [
    'appearance.propose_update',
    'Propose appearance update',
    `Propose visitor chat title, theme, accent, font, or appearance changes. Requires expectedUpdatedAt.${PROPOSE}`,
    'appearance:propose',
    'venue',
    'appearance.update',
  ],
  [
    'customers.propose_invite',
    'Propose customer invite',
    `Propose inviting a customer user to a tenant. Always needs a human.${PROPOSE}`,
    'customers:propose',
    'tenant',
    'customers.invite',
  ],
  [
    'support.propose_triage',
    'Propose support triage',
    `Propose a status and priority change for one support request.${PROPOSE}`,
    'support:propose',
    'venue',
    'support.triage',
  ],
  [
    'operator.propose_plan',
    'Propose plan',
    `Propose an ordered plan of write steps approved once. Stops at the first failing step.${PROPOSE}`,
    'operator:plan',
    'platform',
    'operator.plan',
  ],
  [
    'operator.propose_revert',
    'Propose revert',
    `Propose reverting an applied proposal. Always needs a human.${PROPOSE}`,
    'operator:revert',
    'platform',
    'operator.revert',
  ],
]

export const OPERATOR_MCP_TOOLS: readonly OperatorToolDefinition[] = seeds.map(
  ([name, title, description, capability, scope, proposalKind]) => {
    const isRead = (OPERATOR_READ_TOOL_NAMES as readonly string[]).includes(name)
    return {
      name,
      title,
      description,
      inputSchema: rootSchema(OPERATOR_MCP_INPUTS[name]),
      outputSchema: rootSchema(OPERATOR_MCP_OUTPUTS[name]),
      annotations: {
        readOnlyHint: isRead,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      capability,
      effect: isRead ? 'read' : 'proposal',
      ...(proposalKind ? { proposalKind } : {}),
      scope,
    } satisfies OperatorToolDefinition
  },
)

export function getOperatorToolDefinition(name: string): OperatorToolDefinition | undefined {
  return OPERATOR_MCP_TOOLS.find((tool) => tool.name === name)
}
