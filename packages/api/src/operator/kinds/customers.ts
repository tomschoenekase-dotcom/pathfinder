import { createHash } from 'node:crypto'

import {
  createOrganization,
  ensureOrganizationInvitation,
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
import { assertTenantInGrant, OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
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
}

// Each import is read at call time, so a module that only partly provides the identity package
// (a test double, for example) is not touched until a customer step actually runs.
const realProvider: CustomerProvider = {
  createOrganization: (input) => createOrganization(input),
  validateOwner: (input) => validateExistingOrganizationOwner(input),
  ensureInvitation: (input) => ensureOrganizationInvitation(input),
  listPendingInvitations: (organizationId) => listPendingOrganizationInvitations(organizationId),
}
let provider: CustomerProvider = realProvider

/** Test seam only. Production always uses the real provider. */
export function setCustomerProviderForTests(next: CustomerProvider | null) {
  provider = next ?? realProvider
}

const disabled = (what: string) =>
  Object.assign(new Error(`${what} is not enabled on this deployment.`), { code: 'DISABLED' })

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// ---------------------------------------------------------------------------
// customers.create
// ---------------------------------------------------------------------------

const createInput = OPERATOR_MCP_INPUTS['customers.propose_create']
type CreateArgs = ReturnType<typeof createInput.parse>

const requestHash = (args: CreateArgs) => {
  const { operationId: _operationId, ...rest } = args
  return sha256(rest)
}

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
    result: { ...state, draft: !made.venue.isActive, invited: false, replayed },
    after: state as unknown as JsonValue,
  }
}

export const customersCreateKind: OperatorProposalKind<CreateArgs> = {
  kind: 'customers.create',
  tool: 'customers.propose_create',
  capability: 'customers:propose',
  parse: (raw) => createInput.parse(raw),
  target: () => ({}),
  authorize: async (args, context: OperatorKindContext) => {
    if (!isCustomerCreateEnabled()) throw disabled('Customer creation')
    // A new customer belongs to no existing tenant, so only a connection that reaches all of them may.
    if (!context.grant.allTenants) throw new OperatorNotFoundError()
    if (args.prospectOrganizationId) {
      const organization = await context.database.prospectOrganization.findFirst({
        where: { id: args.prospectOrganizationId },
        select: { id: true },
      })
      if (!organization) throw new OperatorNotFoundError()
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
    if (!isCustomerCreateEnabled()) throw disabled('Customer creation')
    const database = context.database
    const actor = { type: 'HUMAN', id: context.actor.id, role: 'PLATFORM_ADMIN' } as const
    const identity = { requestId: context.operationId, requestHash: requestHash(args), actor }
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
        organizationId = intent.providerOrganizationId
        slug = intent.localSlug
      } else {
        slug = await uniqueSlug(
          database,
          args.slug ?? slugify(args.organizationName),
          args.slug !== undefined,
        )
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
        })
        organizationId = organization.id
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
      if (error instanceof ClientAccountActionError && error.code === 'CONFLICT') {
        throw new OperatorStaleError(error.message)
      }
      if (error instanceof ClientCreateIntentError && error.code === 'CONFLICT') {
        throw new OperatorStaleError(error.message)
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
    if (!isCustomerInviteEnabled()) throw disabled('Customer invitations')
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
    if (!isCustomerInviteEnabled()) throw disabled('Customer invitations')
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
