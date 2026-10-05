import { createHash } from 'node:crypto'

import {
  createOrganization,
  ensureOrganizationInvitation,
  findOrganizationsForCreateOperation,
  listPendingOrganizationInvitations,
  validateExistingOrganizationOwner,
} from '@pathfinder/auth'
import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  beginClientCreateIntentAction,
  ClientAccountActionError,
  ClientCreateIntentError,
  completeClientCreateIntentAction,
  confirmClientCreateProviderAction,
  createClientAccountAction,
  linkProspectConversionAction,
  recordOrReplayOnboardingMilestoneEvent,
  startClientCreateProviderAction,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorDeploymentDisabledError } from '../deployment-prerequisite'
import { assertTenantInGrant, OperatorNotFoundError } from '../grants'
import {
  OPERATOR_OUTCOME_UNKNOWN,
  OPERATOR_PARTIALLY_APPLIED,
  OperatorStaleError,
  proposalArgsHash,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
  type OperatorUnknownResolution,
} from '../proposals'
import { isCustomerCreateEnabled, isCustomerInviteEnabled } from './release-gate'

/**
 * Customer provisioning. Creating a customer and inviting a person are two reviewed steps with two
 * separate deployment switches: creation makes an organization at the identity provider and emails
 * nobody; the invite is the one step that emails, through the identity provider, and the invited
 * person creates their own account and reaches only that customer's dashboard.
 *
 * The identity provider is a seam so the proof can run without calling it.
 */
export type CustomerProvider = {
  createOrganization: typeof createOrganization
  validateOwner: typeof validateExistingOrganizationOwner
  ensureInvitation: typeof ensureOrganizationInvitation
  listPendingInvitations: typeof listPendingOrganizationInvitations
  /** Read-only: finds the organization a given create operation may have made. */
  findOrganizations: typeof findOrganizationsForCreateOperation
}

// Each import is read at call time, so a module that only partly provides the identity package
// (a test double, for example) is not touched until a customer step actually runs.
const realProvider: CustomerProvider = {
  createOrganization: (input) => createOrganization(input),
  validateOwner: (input) => validateExistingOrganizationOwner(input),
  ensureInvitation: (input) => ensureOrganizationInvitation(input),
  listPendingInvitations: (organizationId) => listPendingOrganizationInvitations(organizationId),
  findOrganizations: (input) => findOrganizationsForCreateOperation(input),
}
let provider: CustomerProvider = realProvider

/** Test seam only. Production always uses the real provider. */
export function setCustomerProviderForTests(next: CustomerProvider | null) {
  provider = next ?? realProvider
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')

/** What a customer-create did and did not do, in the words an operator would use. */
const CREATE_SUMMARY = {
  created: 'Client created; draft venue created; no invitation sent.',
  noEffect:
    'Client not created: nothing was changed at the identity provider or locally; no invitation sent.',
  noEffectChecked:
    'Client not created: the identity provider was checked and holds no organization for this operation, and nothing exists locally; no invitation sent.',
  providerOnly:
    'Identity-provider organization created; local client record and draft venue not set up; no invitation sent.',
  clientNoVenue: 'Client created; venue setup failed; no invitation sent.',
  providerUnconfirmed:
    'Client creation is unconfirmed: the identity provider may or may not have created the organization, and the local client record and venue are not confirmed; no invitation sent.',
  finalizeFailed:
    'Client and draft venue created; recording completion or the CRM link failed; no invitation sent.',
  priorUnconfirmed:
    'Client creation was not retried: an earlier attempt is unconfirmed at the identity provider; no invitation sent.',
  ambiguous:
    'Client creation is unconfirmed: more than one identity-provider organization could belong to this operation; a person must choose. No invitation sent.',
  lookupIncomplete:
    'Client creation is unconfirmed: the identity-provider search was incomplete, so absence could not be proved; no invitation sent.',
} as const

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// ---------------------------------------------------------------------------
// customers.create
// ---------------------------------------------------------------------------

const createInput = OPERATOR_MCP_INPUTS['customers.propose_create']
type CreateArgs = ReturnType<typeof createInput.parse>

/** The request identity ignores the operation id itself: a retry carries the same operation. */
const requestHash = (args: CreateArgs) =>
  sha256(Object.entries(args).filter(([key]) => key !== 'operationId'))

async function uniqueSlug(database: OperatorDatabase, base: string, fixed: boolean) {
  const root = base || 'customer'
  let candidate = root
  for (let suffix = 2; ; suffix += 1) {
    const taken = await database.tenant.findFirst({
      where: { slug: candidate },
      select: { id: true },
    })
    if (!taken) return candidate
    if (fixed) throw Object.assign(new Error('That slug is already used.'), { code: 'SLUG_TAKEN' })
    candidate = `${root}-${suffix}`
  }
}

async function slugVersion(database: OperatorDatabase, args: CreateArgs) {
  if (!args.slug) return null
  const taken = await database.tenant.findFirst({
    where: { slug: args.slug },
    select: { id: true },
  })
  return taken ? 'taken' : 'free'
}

async function readCreated(database: OperatorDatabase, tenantId: string, venueId: string) {
  const [tenant, venue] = await Promise.all([
    database.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true },
    }),
    database.venue.findFirst({
      where: { id: venueId, tenantId },
      select: { id: true, slug: true, isActive: true },
    }),
  ])
  return tenant && venue ? { tenant, venue } : null
}

function createdOutcome(
  made: {
    tenant: { id: string; slug: string }
    venue: { id: string; slug: string; isActive: boolean }
  },
  replayed: boolean,
) {
  const state = {
    tenantId: made.tenant.id,
    venueId: made.venue.id,
    slug: made.tenant.slug,
    venueSlug: made.venue.slug,
    isActive: made.venue.isActive,
  }
  return {
    result: {
      ...state,
      draft: !made.venue.isActive,
      invited: false,
      replayed,
      summary: CREATE_SUMMARY.created,
    },
    after: state as unknown as JsonValue,
  }
}

/**
 * Marks an apply failure with what it proves, so the proposal records "no effect" only when that is
 * true and carries a plain-language account of the rest.
 */
function annotateCreateFailure(
  error: unknown,
  phase: 'before_provider' | 'provider' | 'local' | 'finalize',
) {
  if (typeof error !== 'object' || error === null) return
  const target = error as { code?: unknown; provedNoEffect?: boolean; summary?: string }
  if (target.code === 'RECONCILIATION_REQUIRED') {
    target.summary = CREATE_SUMMARY.priorUnconfirmed
    return
  }
  if (phase === 'before_provider') {
    target.provedNoEffect = true
    target.summary = CREATE_SUMMARY.noEffect
  } else if (phase === 'provider') target.summary = CREATE_SUMMARY.providerUnconfirmed
  else if (phase === 'local') target.summary = CREATE_SUMMARY.providerOnly
  else target.summary = CREATE_SUMMARY.finalizeFailed
}

export const customersCreateKind: OperatorProposalKind<CreateArgs> = {
  kind: 'customers.create',
  tool: 'customers.propose_create',
  capability: 'customers:propose',
  parse: (raw) => createInput.parse(raw),
  target: () => ({}),
  authorize: async (args, context: OperatorKindContext) => {
    if (!isCustomerCreateEnabled())
      throw new OperatorDeploymentDisabledError('customers.propose_create')
    // A new customer belongs to no existing tenant, so only a connection that reaches all of them may.
    if (!context.grant.allTenants) throw new OperatorNotFoundError()
    if (args.prospectOrganizationId) {
      const organization = await context.database.prospectOrganization.findFirst({
        where: { id: args.prospectOrganizationId },
        select: { id: true },
      })
      if (!organization) throw new OperatorNotFoundError()
    }
    // A prior operation for this same customer whose outcome is unconfirmed may already have made
    // the identity-provider organization. A new operation would make a second identity, so it is
    // refused until the earlier one is reconciled.
    const prior = await context.database.operatorProposal.findFirst({
      where: {
        kind: 'customers.create',
        argsHash: proposalArgsHash('customers.propose_create', args),
        operationId: { not: args.operationId },
        status: 'FAILED',
        failureCode: { in: [OPERATOR_OUTCOME_UNKNOWN, OPERATOR_PARTIALLY_APPLIED] },
      },
      select: { id: true },
    })
    if (prior) {
      throw Object.assign(new Error(CREATE_SUMMARY.priorUnconfirmed), {
        code: 'UNRECONCILED_PRIOR_OPERATION',
      })
    }
  },
  targetVersion: async (args, context) => slugVersion(context.database, args),
  currentVersion: async (args, context) => slugVersion(context.database, args),
  describe: (args) => ({
    title: 'Create a customer account with one draft venue (nobody is invited or emailed)',
    lines: [
      `customer: ${args.organizationName}`,
      ...(args.slug ? [`slug: ${args.slug}`] : []),
      `venue: ${args.venueName} (draft, not visible to visitors)`,
      ...(args.prospectOrganizationId
        ? [`linked to CRM account ${args.prospectOrganizationId}`]
        : []),
      'Creates an organization at the identity provider.',
    ],
  }),
  snapshot: async (args) =>
    ({ organizationName: args.organizationName, venueName: args.venueName }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    // Checked again: the switch may have been turned off between approval and dispatch.
    if (!isCustomerCreateEnabled())
      throw new OperatorDeploymentDisabledError('customers.propose_create')
    const database = context.database
    const actor = { type: 'HUMAN', id: context.actor.id, role: 'PLATFORM_ADMIN' } as const
    const identity = { requestId: context.operationId, requestHash: requestHash(args), actor }
    // Where an interruption would leave the world: before anything outside local bookkeeping,
    // with the provider call possibly in flight, with the organization confirmed, or finished.
    let phase: 'before_provider' | 'provider' | 'local' | 'finalize' = 'before_provider'
    try {
      const intent = await beginClientCreateIntentAction(identity, database)
      if (intent.state === 'COMPLETED') {
        const made = await readCreated(database, intent.tenantId, intent.venueId)
        if (!made) throw new OperatorStaleError('The completed customer is unavailable.')
        return createdOutcome(made, true)
      }
      if (intent.state === 'RECONCILIATION_REQUIRED') {
        throw Object.assign(
          new Error('The identity provider outcome is unconfirmed. A person must reconcile it.'),
          { code: 'RECONCILIATION_REQUIRED' },
        )
      }
      const owner = await database.user.findUnique({
        where: { id: context.actor.id },
        select: { id: true, email: true },
      })
      if (!owner?.email) {
        throw Object.assign(new Error('The approving administrator has no account record.'), {
          code: 'OWNER_UNRESOLVED',
        })
      }
      let organizationId: string
      let slug: string
      if (intent.state === 'PROVIDER_CONFIRMED') {
        phase = 'local'
        organizationId = intent.providerOrganizationId
        slug = intent.localSlug
      } else {
        slug = await uniqueSlug(
          database,
          args.slug ?? slugify(args.organizationName),
          args.slug !== undefined,
        )
        // Conservative: from here the provider call may happen, so a failure is never "no effect".
        phase = 'provider'
        const started = await startClientCreateProviderAction(
          { ...identity, localSlug: slug },
          database,
        )
        if (started.state !== 'CALL_PROVIDER') {
          throw Object.assign(
            new Error('Provider creation is already in progress or needs reconciling.'),
            { code: 'RECONCILIATION_REQUIRED' },
          )
        }
        const organization = await provider.createOrganization({
          name: args.organizationName,
          slug,
          createdByUserId: context.actor.id,
          // The operation is the organization's stable identity at the provider, so a later
          // reconciliation can find it without creating a second one.
          operationId: context.operationId,
        })
        organizationId = organization.id
        phase = 'local'
        await confirmClientCreateProviderAction(
          { ...identity, providerOrganizationId: organizationId },
          database,
        )
      }
      const validated = await provider.validateOwner({
        organizationId,
        userId: context.actor.id,
        emailAddress: owner.email,
      })
      const place = [args.city, args.region].filter(Boolean).join(', ')
      const created = await createClientAccountAction(
        {
          tenantId: validated.organizationId,
          name: args.organizationName,
          slug,
          providerSlug: validated.organizationSlug,
          owner: { id: validated.userId, email: validated.emailAddress },
          actor,
          initialVenue: {
            name: args.venueName,
            slug: args.venueSlug ?? (slugify(args.venueName) || 'venue'),
            guideMode: args.guideMode,
            isActive: false,
            ...(place ? { guideNotes: `Located in ${place}.` } : {}),
          },
        },
        database,
      )
      phase = 'finalize'
      if (!created.venue) throw new Error('The draft venue was not created.')
      if (args.prospectOrganizationId) {
        await linkProspectConversionAction({
          organizationId: args.prospectOrganizationId,
          ...(args.prospectVenueId
            ? { prospectVenueId: args.prospectVenueId, venueId: created.venue.id }
            : {}),
          tenantId: created.tenant.id,
          evidence: { clientCreateRequestId: context.operationId },
          actor,
        })
      }
      await completeClientCreateIntentAction(
        {
          ...identity,
          providerOrganizationId: organizationId,
          tenantId: created.tenant.id,
          venueId: created.venue.id,
        },
        database,
      )
      const made = await readCreated(database, created.tenant.id, created.venue.id)
      if (!made) throw new Error('The created customer could not be read back.')
      return createdOutcome(made, created.replayed)
    } catch (error) {
      annotateCreateFailure(error, phase)
      // A conflict before the provider call proves nothing changed, so the proposal is stale. After
      // it, an organization may exist, so the failure must stay an unconfirmed outcome.
      if (phase === 'before_provider') {
        if (error instanceof ClientAccountActionError && error.code === 'CONFLICT') {
          throw new OperatorStaleError(error.message)
        }
        if (error instanceof ClientCreateIntentError && error.code === 'CONFLICT') {
          throw new OperatorStaleError(error.message)
        }
      }
      throw error
    }
  },
  /**
   * The intent row is the receipt. Completed means the customer exists; started but not completed
   * means the provider call may or may not have happened, which only a person can settle.
   */
  reconcile: async (_args, context) => {
    const intent = await context.database.clientCreateIntent.findUnique({
      where: { requestId: context.operationId },
      select: { status: true, completedTenantId: true, completedVenueId: true },
    })
    if (!intent || intent.status === 'RESERVED') return { state: 'not_applied' }
    if (intent.status === 'COMPLETED' && intent.completedTenantId && intent.completedVenueId) {
      const made = await readCreated(
        context.database,
        intent.completedTenantId,
        intent.completedVenueId,
      )
      return made
        ? { state: 'applied', outcome: createdOutcome(made, false) }
        : { state: 'unknown' }
    }
    return { state: 'unknown' }
  },
  resolveUnknown: resolveCreateOutcome,
}

/**
 * Looks, read-only, at the intent receipt, the local tenant and the provider, and settles an
 * operation whose outcome was lost. It never calls the create endpoint and never makes a second
 * identity: the only writes are bookkeeping on this operation's own intent row.
 */
async function resolveCreateOutcome(
  args: CreateArgs,
  context: OperatorApplyContext,
): Promise<OperatorUnknownResolution> {
  const database = context.database
  const actor = { type: 'HUMAN', id: context.actor.id, role: 'PLATFORM_ADMIN' } as const
  const identity = { requestId: context.operationId, requestHash: requestHash(args), actor }
  const intent = await database.clientCreateIntent.findUnique({
    where: { requestId: context.operationId },
    select: { status: true, providerOrganizationId: true, createdAt: true },
  })
  // The provider call is only reachable after PROVIDER_STARTED is durable, so no intent, or a
  // merely reserved one, proves the provider was never called.
  if (!intent || intent.status === 'RESERVED') {
    return { state: 'no_effect', summary: CREATE_SUMMARY.noEffect }
  }
  let organizationId = intent.providerOrganizationId
  if (!organizationId) {
    const found = await provider.findOrganizations({
      operationId: context.operationId,
      name: args.organizationName,
      createdByUserId: context.actor.id,
      createdAfter: intent.createdAt,
    })
    const tagged = found.candidates.filter((item) => item.matchedBy === 'operation_metadata')
    const pool = tagged.length > 0 ? tagged : found.candidates
    if (pool.length > 1) return { state: 'unknown', summary: CREATE_SUMMARY.ambiguous }
    if (pool.length === 0) {
      return found.complete
        ? { state: 'no_effect', summary: CREATE_SUMMARY.noEffectChecked }
        : { state: 'unknown', summary: CREATE_SUMMARY.lookupIncomplete }
    }
    organizationId = pool[0]!.id
    // Pin the discovered organization to this operation. The unique claim on the provider
    // organization also stops any other operation from adopting it.
    await confirmClientCreateProviderAction(
      { ...identity, providerOrganizationId: organizationId },
      database,
    )
  }
  const tenant = await database.tenant.findUnique({
    where: { id: organizationId },
    select: { id: true, slug: true, name: true },
  })
  const venue = tenant
    ? await database.venue.findFirst({
        where: { tenantId: tenant.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, slug: true, isActive: true },
      })
    : null
  if (tenant && venue) {
    if (intent.status !== 'COMPLETED') {
      await completeClientCreateIntentAction(
        {
          ...identity,
          providerOrganizationId: organizationId,
          tenantId: tenant.id,
          venueId: venue.id,
        },
        database,
      )
    }
    return { state: 'applied', outcome: createdOutcome({ tenant, venue }, false) }
  }
  return {
    state: 'partially_applied',
    summary: tenant ? CREATE_SUMMARY.clientNoVenue : CREATE_SUMMARY.providerOnly,
    result: {
      organizationId,
      providerOrganization: 'created',
      clientCreated: tenant !== null,
      venueCreated: false,
      invited: false,
    },
  }
}

// ---------------------------------------------------------------------------
// customers.invite
// ---------------------------------------------------------------------------

const inviteInput = OPERATOR_MCP_INPUTS['customers.propose_invite']
type InviteArgs = ReturnType<typeof inviteInput.parse>
const clerkRole = (role: InviteArgs['role']) => (role === 'ADMIN' ? 'org:admin' : 'org:member')

/** A stable UUID for the milestone row, so a retried apply records it once. */
function milestoneId(operationId: string) {
  const hex = createHash('sha256').update(`operator-invite:${operationId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const customersInviteKind: OperatorProposalKind<InviteArgs> = {
  kind: 'customers.invite',
  tool: 'customers.propose_invite',
  capability: 'customers:propose',
  parse: (raw) => inviteInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId }),
  authorize: async (args, context: OperatorKindContext) => {
    if (!isCustomerInviteEnabled())
      throw new OperatorDeploymentDisabledError('customers.propose_invite')
    await assertTenantInGrant(context.grant, args.tenantId, context.database)
    const tenant = await context.database.tenant.findUnique({
      where: { id: args.tenantId },
      select: { id: true },
    })
    if (!tenant) throw new OperatorNotFoundError()
  },
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({
    title: `Invite ${args.email} to this customer's dashboard (the identity provider emails them a sign-up link)`,
    lines: [`customer ${args.tenantId}`, `email: ${args.email}`, `role: ${args.role}`],
  }),
  snapshot: async (args) =>
    ({ tenantId: args.tenantId, email: args.email, role: args.role }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    if (!isCustomerInviteEnabled())
      throw new OperatorDeploymentDisabledError('customers.propose_invite')
    const invitation = await provider.ensureInvitation({
      organizationId: args.tenantId,
      emailAddress: args.email,
      role: clerkRole(args.role),
      inviterUserId: context.actor.id,
    })
    const venue = await context.database.venue.findFirst({
      where: { tenantId: args.tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
    if (venue) {
      await recordOrReplayOnboardingMilestoneEvent({
        db: context.database,
        input: {
          id: milestoneId(context.operationId),
          tenantId: args.tenantId,
          venueId: venue.id,
          eventType: 'INVITATION_STARTED',
          idempotencyKey: `operator:${context.operationId}:invitation`,
          occurredAt: context.now,
          actorType: 'OPERATOR',
          actorId: context.actor.id,
          sourceType: 'ORGANIZATION_INVITATION',
          sourceId: invitation.id,
        },
      })
    }
    return {
      result: {
        invitationId: invitation.id,
        replayed: invitation.replayed,
        role: args.role,
        emailedByProvider: !invitation.replayed,
      },
      after: { invitationId: invitation.id } as unknown as JsonValue,
    }
  },
  /** A matching pending invitation proves an interrupted apply reached the provider. */
  reconcile: async (args) => {
    const pending = await provider.listPendingInvitations(args.tenantId)
    const found = pending.find(
      (item) => item.emailAddress.trim().toLowerCase() === args.email.toLowerCase(),
    )
    if (!found) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: {
          invitationId: found.id,
          replayed: true,
          role: args.role,
          emailedByProvider: false,
        },
        after: { invitationId: found.id } as unknown as JsonValue,
      },
    }
  },
}

export const CUSTOMER_KINDS = [customersCreateKind, customersInviteKind]
