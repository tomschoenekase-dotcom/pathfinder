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
export const ProspectCampaignStatusValue = z.enum([
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETE',
  'CANCELLED',
])
export const ProspectCampaignMemberStatusValue = z.enum([
  'SELECTED',
  'DRAFTED',
  'NEEDS_REVIEW',
  'APPROVED',
  'QUEUED',
  'SENT',
  'REPLIED',
  'BOUNCED',
  'SUPPRESSED',
  'FAILED',
  'CANCELLED',
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
  'operator.get_context',
  'operator.get_operation',
  'operator.list_plans',
  'customers.list',
  'crm.list_campaigns',
  'crm.list_campaign_members',
] as const

/**
 * Controls act on the connection's own queued work (cancel it, resume it after an interruption).
 * They create no new proposal and widen no authority: a resume only continues what a human or
 * policy already approved, under a fresh authority check.
 */
export const OPERATOR_CONTROL_TOOL_NAMES = [
  'operator.cancel_operation',
  'operator.recover_operation',
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
export type OperatorControlToolName = (typeof OPERATOR_CONTROL_TOOL_NAMES)[number]
export type OperatorToolName =
  | OperatorReadToolName
  | OperatorWriteToolName
  | OperatorControlToolName
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
  'operator.get_context': readInput({}),
  'operator.get_operation': readInput({ originalOperationId: OperationId }),
  'operator.list_plans': readInput({
    status: OperatorProposalStatus.optional(),
    cursor: Cursor.optional(),
    limit: PageLimit,
  }),
  'customers.list': readInput({
    query: z.string().trim().min(1).max(200).optional(),
    cursor: Cursor.optional(),
    limit: PageLimit,
  }),
  'crm.list_campaigns': readInput({
    status: ProspectCampaignStatusValue.optional(),
    cursor: Cursor.optional(),
    limit: PageLimit,
  }),
  'operator.cancel_operation': readInput({ originalOperationId: OperationId }),
  'operator.recover_operation': readInput({ originalOperationId: OperationId }),
  'crm.list_campaign_members': readInput({
    campaignId: Identifier,
    organizationId: Identifier.optional(),
    status: ProspectCampaignMemberStatusValue.optional(),
    cursor: Cursor.optional(),
    limit: PageLimit,
  }),

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
    /** The sending mailbox. With it, the receipt key is namespaced to that mailbox. */
    mailbox: Email.optional(),
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

/**
 * Every list says whether it is complete. `complete` is true only when `nextCursor` is null, so a
 * capped first page can never be mistaken for the whole set.
 */
const Page = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item).max(25),
      nextCursor: z.string().max(500).nullable(),
      complete: z.boolean(),
    })
    .strict()

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

/**
 * What is known about whether the change reached the system, derived from recorded state:
 * `none` is proven no effect, `applied` is a recorded success, `partial` means some plan steps
 * applied and others did not, and `unknown` means an apply began and its outcome was not recorded
 * as a success. Read the target before telling anyone nothing changed when this is `unknown`.
 */
export const OperatorEffect = z.enum(['none', 'applied', 'partial', 'unknown'])
export type OperatorEffect = z.infer<typeof OperatorEffect>

const OperatorProposalView = z
  .object({
    proposalId: Identifier,
    operationId: z.string().max(64).optional(),
    tool: z.string().max(80),
    kind: z.string().max(80),
    status: OperatorProposalStatus,
    effect: OperatorEffect.optional(),
    argsHash: Sha256Hex,
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
    decidedAt: IsoDateTime.nullable().optional(),
    appliedAt: IsoDateTime.nullable().optional(),
    /** Who authorized it: a person, or the owner's standing policy. Null while undecided. */
    authorizedBy: z.enum(['human', 'policy']).nullable().optional(),
    /** The connection (client) that proposed it, which is not the approver. */
    initiatedByClientId: z.string().max(64).optional(),
    /** Where the work is: waiting, queued, running, needing recovery, or finished/closed. */
    execution: z
      .object({
        state: z.enum([
          'awaiting_approval',
          'queued',
          'running',
          'needs_recovery',
          'finished',
          'closed',
        ]),
        attempt: z.number().int().nonnegative(),
        leaseExpiresAt: IsoDateTime.nullable(),
      })
      .strict()
      .optional(),
    planId: Identifier.nullable().optional(),
    planStepIndex: z.number().int().nonnegative().nullable().optional(),
    failureCode: z.string().max(120).nullable().optional(),
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
        /** `null` means no priority has been recorded; it is never a defaulted value. */
        priority: OperatorSupportPriority.nullable(),
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
      /** Increments on every owner policy change, so a change can be cited and detected. */
      revision: z.number().int().nonnegative(),
      policies: z
        .array(
          z
            .object({
              capability: OperatorCapability,
              mode: z.enum(['ask', 'auto']),
              locked: z.boolean(),
              /** The actions an automatic switch actually covers; empty while it asks. */
              autoKinds: z.array(z.string().max(80)).max(30),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),

  'operator.get_context': z
    .object({
      serverTime: IsoDateTime,
      catalogVersion: z.string().max(80),
      manualVersion: z.string().max(80),
      releaseRevision: z.string().max(64),
      grant: z
        .object({
          grantId: Identifier,
          allTenants: z.boolean(),
          tenantCount: z.number().int().nonnegative(),
          /** Capped at 100; `tenantCount` is the true size. Use customers.list to page them all. */
          tenantIds: z.array(Identifier).max(100),
          capabilities: z.array(OperatorCapability).max(50),
        })
        .strict(),
      /** Plain-language scope facts the grant does not make obvious. */
      scopeNotes: z.array(z.string().max(300)).max(20),
      /** Every declared tool, including declared tools that have no handler yet. */
      tools: z
        .array(
          z
            .object({
              name: z.string().max(80),
              effect: z.enum(['read', 'proposal', 'control']),
              scope: OperatorToolScope,
              capability: OperatorCapability,
              /** A handler is registered in this build. */
              implemented: z.boolean(),
              /** This grant carries the capability the tool needs. */
              authorized: z.boolean(),
              /** `auto` or `ask` for proposal tools; null for reads and for unavailable tools. */
              approvalMode: z.enum(['ask', 'auto']).nullable(),
              /** Last time this grant called the tool successfully; null if never recorded. */
              lastSuccessAt: IsoDateTime.nullable(),
              /** Not measured by this server. A provider or worker needs its own health read. */
              providerConnected: z.null(),
              workerAvailable: z.null(),
            })
            .strict(),
        )
        .max(120),
    })
    .strict(),
  'operator.get_operation': OperatorProposalView,
  'operator.cancel_operation': OperatorProposalView,
  'operator.recover_operation': OperatorProposalView,
  'operator.list_plans': Page(OperatorProposalView),
  'customers.list': Page(
    z
      .object({
        tenantId: Identifier,
        name: z.string().max(200),
        slug: z.string().max(200),
        status: z.string().max(40),
        planTier: z.string().max(80),
        venueCount: z.number().int().nonnegative(),
        updatedAt: IsoDateTime,
      })
      .strict(),
  ),
  'crm.list_campaigns': Page(
    z
      .object({
        campaignId: Identifier,
        name: z.string().max(191),
        status: ProspectCampaignStatusValue,
        memberCount: z.number().int().nonnegative(),
        dailyLimit: z.number().int().nonnegative(),
        pausedAt: IsoDateTime.nullable(),
        updatedAt: IsoDateTime,
      })
      .strict(),
  ),
  'crm.list_campaign_members': Page(
    z
      .object({
        campaignMemberId: Identifier,
        campaignId: Identifier,
        organizationId: Identifier,
        organizationName: z.string().max(200),
        venueId: Identifier.nullable(),
        contactId: Identifier.nullable(),
        status: ProspectCampaignMemberStatusValue,
        draftCount: z.number().int().nonnegative(),
        updatedAt: IsoDateTime,
      })
      .strict(),
  ),

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
    case 'ZodNull':
      return { type: 'null' }
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

export type OperatorToolEffect = 'read' | 'proposal' | 'control'

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
    'operator.get_context',
    'Get operator context',
    `Read what this connection can reach: grant scope, per-tool implemented/authorized/autonomy state, last success, and scope caveats. Call first.${READ}`,
    'operator:read',
    'platform',
  ],
  [
    'operator.get_operation',
    'Get operation',
    `Recover a past write from the operationId you originally sent (pass it as originalOperationId) (a proposal or a plan), with its status and what is known about whether it took effect.${READ}`,
    'operator:read',
    'platform',
  ],
  [
    'operator.list_plans',
    'List plans',
    `List this connection's plans with per-status filtering. Use get_proposal with a planId for step detail.${READ}`,
    'operator:read',
    'platform',
  ],
  [
    'customers.list',
    'List customers',
    `List customer tenants this connection may reach, with the tenantId that venue, support and customer tools require.${READ}`,
    'venues:read',
    'platform',
  ],
  [
    'crm.list_campaigns',
    'List campaigns',
    `List outreach campaigns with member counts.${READ}`,
    'crm:read',
    'platform',
  ],
  [
    'crm.list_campaign_members',
    'List campaign members',
    `List the members of one campaign (optionally one organization) with the campaignMemberId that draft proposals need.${READ}`,
    'crm:read',
    'platform',
  ],

  [
    'operator.cancel_operation',
    'Cancel operation',
    `Withdraw one of this connection's own proposals or plans that has not started running (pass the operationId you originally sent as originalOperationId). Stops future steps only: it does not undo anything already applied, and refuses work that is running.`,
    'operator:plan',
    'platform',
  ],
  [
    'operator.recover_operation',
    'Recover operation',
    `Continue an already-approved operation whose worker was interrupted (pass the original operationId). It re-checks the connection and scope first, never repeats an effect that may have happened, and holds an undecidable outcome for a human. It cannot approve anything.`,
    'operator:plan',
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
    `Propose making a venue available to visitors (sets it active) at the observed updatedAt. This is availability only; it does not publish content or enable a website or app surface.${PROPOSE}`,
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
    `Propose an ordered plan of write steps approved once. Stops at the first failing step; earlier applied steps stay applied (not atomic, no automatic rollback).${PROPOSE}`,
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
    const isControl = (OPERATOR_CONTROL_TOOL_NAMES as readonly string[]).includes(name)
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
      effect: isRead ? 'read' : isControl ? 'control' : 'proposal',
      ...(proposalKind ? { proposalKind } : {}),
      scope,
    } satisfies OperatorToolDefinition
  },
)

export function getOperatorToolDefinition(name: string): OperatorToolDefinition | undefined {
  return OPERATOR_MCP_TOOLS.find((tool) => tool.name === name)
}
