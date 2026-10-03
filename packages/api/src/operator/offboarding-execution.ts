import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import {
  beginOffboardingExecutionAction,
  completeOffboardingExecutionAction,
  ExternalCredentialActionError,
  failOffboardingExecutionStepAction,
  isEffectStep,
  isStepPlanned,
  plannedTargetsForStep,
  markOffboardingExecutionReinstatedAction,
  OFFBOARDING_EXECUTION_STEP_KEYS,
  OFFBOARDING_FUTURE_DECISIONS,
  OffboardingExecutionError,
  offboardingDerivedUuid,
  offboardingManifestHash,
  readOffboardingExecutionAction,
  readOffboardingExecutionFacts,
  revokeExternalCredentialAction,
  setAgentRoutineEnabledAction,
  settleOffboardingExecutionStepAction,
  setVenueAvailabilityAction,
  updateClientStatusAction,
  writeAuditLogStrict,
  type OffboardingExecutionStepKeyName,
  type OffboardingExecutionView,
  type OffboardingStepSettlement,
} from '@pathfinder/db'

import type { OperatorDatabase } from './audit'
import { revokeOperatorGrant } from './oauth'
import { operatorReason, venueActor } from './kinds/shared'
import type { OperatorApplyContext, OperatorApplyOutcome, OperatorHumanActor } from './proposals'

/**
 * Executes an approved offboarding plan, one recorded step at a time.
 *
 * Every step is idempotent and settles durably before the next one starts, so a failure stops the
 * run at a known step and a later proposal for the same plan resumes from there; a step already
 * settled is never run again. Nothing here deletes data, and nothing reaches a payment provider or
 * the identity provider: those two are recorded as checklist items for a person.
 */

export type OffboardingExecutionHooks = {
  /** Test seam only: runs before a step's effect. Throwing simulates that step failing. */
  beforeStep?: (key: OffboardingExecutionStepKeyName) => void | Promise<void>
}

export type OffboardingPriorState = {
  tenant: { status: 'ACTIVE' | 'SUSPENDED' | 'TRIAL'; updatedAt: string }
  venues: Array<{ id: string; isActive: boolean }>
  memberships: Array<{ id: string; status: 'ACTIVE' | 'INVITED' | 'REMOVED' }>
  routines: Array<{ id: string; venueId: string; enabled: boolean }>
  reportConfigurations: Array<{ id: string; enabled: boolean }>
  liveDataConnectors: Array<{ id: string; state: 'ACTIVE' | 'DISABLED' }>
  agentIdentities: Array<{ id: string; enabled: boolean }>
  credentials: Array<{ id: string; kind: string }>
  operatorGrants: Array<{ id: string; tenantIds: string[] }>
}

type StepEnvironment = {
  database: OperatorDatabase
  tenantId: string
  planId: string
  executionId: string
  venueIds: string[]
  actor: OperatorHumanActor
  proposalId: string
  operationId: string
  now: Date
  billingHandled: boolean
  billingNote: string | null
  plannedTargets: string[]
}

type StepRunner = (env: StepEnvironment) => Promise<OffboardingStepSettlement>

async function auditEffect(env: StepEnvironment, step: string, counts: Record<string, number>) {
  await writeAuditLogStrict(
    {
      tenantId: env.tenantId,
      actorId: env.actor.id,
      actorRole: env.actor.role,
      action: 'offboarding-execution.effect',
      targetType: 'OffboardingPlan',
      targetId: env.planId,
      afterState: { executionId: env.executionId, step, ...counts },
    },
    env.database,
  )
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Guest chat, QR links and embeds all refuse a venue that is not active. */
const closePublicAccess: StepRunner = async (env) => {
  let closed = 0
  let alreadyClosed = 0
  for (const venueId of [...env.venueIds].sort()) {
    const venue = await env.database.venue.findFirst({
      where: { id: venueId, tenantId: env.tenantId },
      select: { id: true, isActive: true, updatedAt: true },
    })
    if (!venue) throw Object.assign(new Error('Venue not found'), { code: 'NOT_FOUND' })
    if (!venue.isActive) {
      alreadyClosed += 1
      continue
    }
    await setVenueAvailabilityAction(
      {
        tenantId: env.tenantId,
        venueId,
        expectedUpdatedAt: venue.updatedAt,
        enabled: false,
        reason: `Offboarding. ${operatorReason(env.proposalId)}`,
        actor: venueActor(env.actor, 'MANAGER'),
      },
      env.database,
    )
    closed += 1
  }
  return {
    status: 'COMPLETE',
    outcome: {
      venuesClosed: closed,
      venuesAlreadyClosed: alreadyClosed,
      guestChat: 'not served',
      qrAndEmbeds: 'show the neutral closed page',
    },
  }
}

const stopScheduledWork: StepRunner = async (env) => {
  const routines = await env.database.agentRoutine.findMany({
    where: { tenantId: env.tenantId, enabled: true },
    select: { id: true, venueId: true },
    orderBy: { id: 'asc' },
  })
  for (const routine of routines) {
    await setAgentRoutineEnabledAction(
      {
        operationId: offboardingDerivedUuid(`${env.executionId}:routine:${routine.id}`),
        tenantId: env.tenantId,
        venueId: routine.venueId,
        routineId: routine.id,
        enabled: false,
      },
      env.actor.id,
      { now: env.now, client: env.database },
    )
  }
  const reports = await env.database.venueReportConfiguration.updateMany({
    where: { tenantId: env.tenantId, enabled: true },
    data: { enabled: false, updatedBy: env.actor.id },
  })
  const connectors = await env.database.liveDataConnector.updateMany({
    where: { tenantId: env.tenantId, state: 'ACTIVE' },
    data: { state: 'DISABLED', nextPollAt: null, updatedBy: env.actor.id },
  })
  const counts = {
    routinesDisabled: routines.length,
    reportSchedulesDisabled: reports.count,
    liveDataFeedsDisabled: connectors.count,
  }
  await auditEffect(env, 'SCHEDULED_WORK', counts)
  return {
    status: 'COMPLETE',
    outcome: {
      ...counts,
      platformScheduledJobs:
        'skipped for this customer once its status is suspended (the member-access step)',
    },
  }
}

const revokeConnections: StepRunner = async (env) => {
  const selected = new Set(plannedTargetsForStep('CONNECTIONS', env.plannedTargets))
  const credentialKinds = [
    ...(selected.has('PARTNER_API_KEYS') ? ['PARTNER_READ_API' as const] : []),
    ...(selected.has('MCP_CREDENTIALS') ? ['MCP' as const] : []),
  ]
  let credentialsRevoked = 0
  const credentials =
    credentialKinds.length > 0
      ? await env.database.externalAccessCredential.findMany({
          where: { tenantId: env.tenantId, revokedAt: null, kind: { in: credentialKinds } },
          select: { id: true, venueId: true, updatedAt: true },
          orderBy: { id: 'asc' },
        })
      : []
  for (const credential of credentials) {
    try {
      await revokeExternalCredentialAction(
        {
          operationId: offboardingDerivedUuid(`${env.executionId}:credential:${credential.id}`),
          tenantId: env.tenantId,
          clientId: env.tenantId,
          venueId: credential.venueId,
          credentialId: credential.id,
          expectedUpdatedAt: credential.updatedAt,
          reasonCode: 'TENANT_OFFBOARDING',
          actor: { type: 'HUMAN', id: env.actor.id, role: 'PLATFORM_ADMIN' },
        },
        env.database,
      )
      credentialsRevoked += 1
    } catch (error) {
      // Already revoked between the read and the call (a resumed run, or a person): nothing to do.
      const current = await env.database.externalAccessCredential.findFirst({
        where: { id: credential.id, tenantId: env.tenantId },
        select: { revokedAt: true },
      })
      if (!(error instanceof ExternalCredentialActionError) || current?.revokedAt == null) {
        throw error
      }
    }
  }
  const sessions = selected.has('MCP_CREDENTIALS')
    ? await env.database.agentBridgeSession.updateMany({
        where: { tenantId: env.tenantId, status: { in: ['ONLINE', 'OFFLINE'] } },
        data: { status: 'REVOKED', expiresAt: env.now },
      })
    : { count: 0 }
  const identities = selected.has('AGENT_IDENTITIES')
    ? await env.database.agentIdentity.updateMany({
        where: { tenantId: env.tenantId, enabled: true },
        data: { enabled: false },
      })
    : { count: 0 }

  // Operator connections limited to this customer end; a connection that reaches several keeps
  // the others. A connection that reaches every customer is a platform matter and is not touched.
  const grants = selected.has('MCP_CREDENTIALS')
    ? await env.database.operatorGrant.findMany({
        where: { revokedAt: null, allTenants: false, tenantIds: { has: env.tenantId } },
        select: { id: true, tenantIds: true },
        orderBy: { id: 'asc' },
      })
    : []
  let grantsRevoked = 0
  let grantsNarrowed = 0
  for (const grant of grants) {
    let currentIds = grant.tenantIds
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!currentIds.includes(env.tenantId)) break
      const others = currentIds.filter((id) => id !== env.tenantId)
      if (others.length === 0) {
        await revokeOperatorGrant(
          {
            grantId: grant.id,
            reason: 'tenant_offboarding',
            now: env.now,
            requestId: env.operationId,
            actorUserId: env.actor.id,
          },
          env.database,
        )
        grantsRevoked += 1
        break
      }
      const changed = await env.database.operatorGrant.updateMany({
        where: { id: grant.id, revokedAt: null, tenantIds: { equals: currentIds } },
        data: { tenantIds: others },
      })
      if (changed.count === 1) {
        grantsNarrowed += 1
        break
      }
      const fresh = await env.database.operatorGrant.findUnique({
        where: { id: grant.id },
        select: { tenantIds: true, revokedAt: true },
      })
      if (!fresh || fresh.revokedAt !== null || !fresh.tenantIds.includes(env.tenantId)) break
      currentIds = fresh.tenantIds
      if (attempt === 7)
        throw Object.assign(new Error('Connection changed during offboarding'), {
          code: 'CONFLICT',
        })
    }
  }
  const counts = {
    credentialsRevoked,
    bridgeSessionsRevoked: sessions.count,
    agentIdentitiesDisabled: identities.count,
    operatorConnectionsRevoked: grantsRevoked,
    operatorConnectionsNarrowed: grantsNarrowed,
  }
  await auditEffect(env, 'CONNECTIONS', counts)
  return { status: 'COMPLETE', outcome: counts }
}

/**
 * The app has no per-request customer status gate. These are local records only: the customer's
 * status becomes SUSPENDED and memberships become REMOVED, but existing Clerk organization sessions
 * may still reach app reads until a person removes access at the identity provider. The mandatory
 * IDENTITY_PROVIDER checklist says so explicitly; no local record is presented as access revocation.
 */
const suspendMemberAccess: StepRunner = async (env) => {
  const tenant = await env.database.tenant.findUnique({
    where: { id: env.tenantId },
    select: { status: true, updatedAt: true },
  })
  if (!tenant) throw Object.assign(new Error('Customer not found'), { code: 'NOT_FOUND' })
  if (tenant.status !== 'SUSPENDED') {
    await updateClientStatusAction(
      {
        tenantId: env.tenantId,
        expectedUpdatedAt: tenant.updatedAt,
        status: 'SUSPENDED',
        actor: { type: 'HUMAN', id: env.actor.id, role: 'PLATFORM_ADMIN' },
      },
      env.database,
    )
  }
  const members = await env.database.tenantMembership.updateMany({
    where: { tenantId: env.tenantId, status: { in: ['ACTIVE', 'INVITED'] } },
    data: { status: 'REMOVED' },
  })
  const counts = { membershipsMarkedRemoved: members.count }
  await auditEffect(env, 'MEMBER_ACCESS', counts)
  return {
    status: 'COMPLETE',
    outcome: {
      ...counts,
      customerStatus: 'SUSPENDED',
      statusBefore: tenant.status,
      appAccessBlocked: false,
    },
  }
}

/** Records the payment cancellation for a person. This system never calls the payment provider. */
const recordBillingChecklist: StepRunner = async (env) => {
  const account = await env.database.billingAccount.findUnique({
    where: { tenantId: env.tenantId },
    select: {
      status: true,
      billingMode: true,
      commercialAgreements: {
        where: { tenantId: env.tenantId },
        select: { status: true, billingMode: true, stripeSubscriptionId: true },
      },
    },
  })
  const agreements = account?.commercialAgreements ?? []
  const base = {
    billingAccountStatus: account?.status ?? null,
    agreements: agreements.map((agreement) => ({
      status: agreement.status,
      billingMode: agreement.billingMode,
      providerSubscription: agreement.stripeSubscriptionId !== null,
    })),
  }
  if (!account) {
    return {
      status: 'COMPLETE',
      outcome: { ...base, note: 'No billing account exists; nothing to cancel.' },
    }
  }
  if (env.billingHandled) {
    return {
      status: 'COMPLETE',
      outcome: {
        ...base,
        handledByPerson: true,
        note: env.billingNote,
      },
    }
  }
  return {
    status: 'ACTION_REQUIRED',
    outcome: {
      ...base,
      cancellationRequired: true,
      checklist: [
        'Cancel or settle this customer’s paid arrangement at the payment provider. This system did not and will not do it.',
        'Confirm no further invoice or renewal will be issued.',
        'Decide any refund or final invoice yourself.',
      ],
    },
  }
}

/** Records the identity-provider action for a person. No users or organizations are deleted. */
const recordIdentityProviderChecklist: StepRunner = async (env) => {
  const members = await env.database.tenantMembership.count({
    where: { tenantId: env.tenantId, status: 'REMOVED' },
  })
  return {
    status: 'ACTION_REQUIRED',
    outcome: {
      identityProviderActionRequired: true,
      organizationId: env.tenantId,
      membersRecordedAsRemoved: members,
      checklist: [
        'At the identity provider, remove the members of this organization or disable their sign-in. Local SUSPENDED/REMOVED records do not block existing Clerk sessions or every app read. This system did not call the identity provider.',
        'Do not delete the organization or any user until the retention decision is made.',
      ],
    },
  }
}

/** Counts of what exists, so a person can see what is being preserved. Nothing is read in full. */
const buildDataManifest: StepRunner = async (env) => {
  const where = { tenantId: env.tenantId }
  const db = env.database
  const [
    venues,
    places,
    knowledgeEntries,
    contentVersions,
    packages,
    botConfigurations,
    visitorSessions,
    messages,
    operationalUpdates,
    supportRequests,
    memberships,
    routines,
    credentials,
    connectors,
    auditEvents,
    analyticsEvents,
  ] = await Promise.all([
    db.venue.count({ where }),
    db.place.count({ where }),
    db.venueKnowledgeEntry.count({ where }),
    db.contentVersion.count({ where }),
    db.venuePackage.count({ where }),
    db.venueBotConfiguration.count({ where }),
    db.visitorSession.count({ where }),
    db.message.count({ where }),
    db.operationalUpdate.count({ where }),
    db.supportRequest.count({ where }),
    db.tenantMembership.count({ where }),
    db.agentRoutine.count({ where }),
    db.externalAccessCredential.count({ where }),
    db.liveDataConnector.count({ where }),
    db.auditLog.count({ where }),
    db.analyticsEvent.count({ where }),
  ])
  const counts = {
    venues,
    places,
    knowledgeEntries,
    contentVersions,
    packages,
    botConfigurations,
    visitorSessions,
    messages,
    operationalUpdates,
    supportRequests,
    memberships,
    routines,
    credentials,
    liveDataConnectors: connectors,
    auditEvents,
    analyticsEvents,
  }
  return {
    status: 'COMPLETE',
    outcome: {
      generatedAt: env.now.toISOString(),
      counts,
      countsSha256: offboardingManifestHash(counts),
      dataDeleted: false,
      futureDecisions: [...OFFBOARDING_FUTURE_DECISIONS],
    },
  }
}

const STEP_RUNNERS: Record<OffboardingExecutionStepKeyName, StepRunner> = {
  PUBLIC_ACCESS: closePublicAccess,
  SCHEDULED_WORK: stopScheduledWork,
  CONNECTIONS: revokeConnections,
  MEMBER_ACCESS: suspendMemberAccess,
  BILLING: recordBillingChecklist,
  IDENTITY_PROVIDER: recordIdentityProviderChecklist,
  DATA_MANIFEST: buildDataManifest,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const REFUSAL_CODES = new Set([
  'PLAN_NOT_APPROVED',
  'PLAN_SCOPE_INCOMPLETE',
  'BILLING_ACTIVE',
  'EXECUTION_CLOSED',
])

/** What a failed execution did and did not do, in words an operator would use. */
export const OFFBOARDING_SUMMARY = {
  partial:
    'Offboarding is partly applied: the steps recorded as complete stay complete and nothing was deleted. Propose the same plan again to resume at the step that failed.',
} as const

/** Maps a gate or lookup error to the operator's named refusals. Anything else is returned as is. */
export function mapOffboardingError(error: unknown): unknown {
  if (error instanceof OffboardingExecutionError) {
    if (error.code === 'NOT_FOUND')
      return Object.assign(new Error('Not found'), { code: 'NOT_FOUND' })
    if (REFUSAL_CODES.has(error.code)) {
      return Object.assign(new Error(error.message), { code: error.code, provedNoEffect: true })
    }
    if (error.code === 'CONFLICT') return Object.assign(error, { code: 'STALE' })
  }
  return error
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code)
    if (/^[A-Z0-9_:-]{1,60}$/u.test(code)) return code
  }
  return 'STEP_FAILED'
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export type OffboardingExecutionArgs = {
  tenantId: string
  planId: string
  billingHandled: boolean
  billingNote?: string | undefined
}

const HUMAN_STEPS: ReadonlyArray<OffboardingExecutionStepKeyName> = ['BILLING', 'IDENTITY_PROVIDER']

function checklistOf(execution: OffboardingExecutionView): string[] {
  const items: string[] = []
  for (const step of execution.steps) {
    if (step.status !== 'ACTION_REQUIRED' && !HUMAN_STEPS.includes(step.key)) continue
    const outcome = step.outcome as { checklist?: unknown } | null
    if (outcome && Array.isArray(outcome.checklist)) {
      for (const item of outcome.checklist) if (typeof item === 'string') items.push(item)
    }
  }
  return items
}

/** A settled receipt is historical evidence, not proof that a later actor left the state off. */
async function assertLivePostconditions(env: StepEnvironment) {
  const selected = new Set(env.plannedTargets)
  const failures: string[] = []
  if (isStepPlanned('PUBLIC_ACCESS', env.plannedTargets)) {
    if (await env.database.venue.count({ where: { tenantId: env.tenantId, isActive: true } })) {
      failures.push('PUBLIC_ACCESS')
    }
  }
  if (selected.has('BACKGROUND_JOBS')) {
    const [routines, reports, feeds] = await Promise.all([
      env.database.agentRoutine.count({ where: { tenantId: env.tenantId, enabled: true } }),
      env.database.venueReportConfiguration.count({
        where: { tenantId: env.tenantId, enabled: true },
      }),
      env.database.liveDataConnector.count({ where: { tenantId: env.tenantId, state: 'ACTIVE' } }),
    ])
    if (routines || reports || feeds) failures.push('SCHEDULED_WORK')
  }
  if (selected.has('PARTNER_API_KEYS')) {
    if (
      await env.database.externalAccessCredential.count({
        where: { tenantId: env.tenantId, kind: 'PARTNER_READ_API', revokedAt: null },
      })
    )
      failures.push('PARTNER_API_KEYS')
  }
  if (selected.has('MCP_CREDENTIALS')) {
    const [credentials, sessions, grants] = await Promise.all([
      env.database.externalAccessCredential.count({
        where: { tenantId: env.tenantId, kind: 'MCP', revokedAt: null },
      }),
      env.database.agentBridgeSession.count({
        where: { tenantId: env.tenantId, status: { in: ['ONLINE', 'OFFLINE'] } },
      }),
      env.database.operatorGrant.count({
        where: { revokedAt: null, allTenants: false, tenantIds: { has: env.tenantId } },
      }),
    ])
    if (credentials || sessions || grants) failures.push('MCP_CREDENTIALS')
  }
  if (selected.has('AGENT_IDENTITIES')) {
    if (
      await env.database.agentIdentity.count({ where: { tenantId: env.tenantId, enabled: true } })
    )
      failures.push('AGENT_IDENTITIES')
  }
  if (selected.has('CLIENT_ACCESS')) {
    const [tenant, members] = await Promise.all([
      env.database.tenant.findUnique({ where: { id: env.tenantId }, select: { status: true } }),
      env.database.tenantMembership.count({
        where: { tenantId: env.tenantId, status: { in: ['ACTIVE', 'INVITED'] } },
      }),
    ])
    if (tenant?.status !== 'SUSPENDED' || members) failures.push('MEMBER_ACCESS')
  }
  if (failures.length > 0) {
    throw Object.assign(
      new Error(
        `Previously settled offboarding effects changed: ${failures.join(', ')}. Inspect and correct them before retrying.`,
      ),
      {
        code: 'PARTIALLY_APPLIED',
      },
    )
  }
}

export function offboardingOutcome(
  execution: OffboardingExecutionView,
  replayed: boolean,
): OperatorApplyOutcome {
  const humanActions = checklistOf(execution)
  const manifest = execution.steps.find((step) => step.key === 'DATA_MANIFEST')?.outcome as
    | { counts?: unknown; countsSha256?: unknown }
    | null
    | undefined
  const state = {
    executionId: execution.id,
    planId: execution.planId,
    tenantId: execution.tenantId,
    status: execution.status,
  }
  return {
    result: {
      ...state,
      replayed,
      steps: execution.steps.map((step) => ({ step: step.key, status: step.status })) as JsonValue,
      humanActions,
      futureDecisions: [...OFFBOARDING_FUTURE_DECISIONS],
      dataDeleted: false,
      ...(manifest?.counts ? { manifest: manifest.counts as JsonValue } : {}),
      ...(typeof manifest?.countsSha256 === 'string'
        ? { manifestSha256: manifest.countsSha256 }
        : {}),
      summary:
        humanActions.length > 0
          ? 'Offboarding applied. Nothing was deleted. A person still has work to do: see humanActions.'
          : 'Offboarding applied. Nothing was deleted.',
    },
    after: state as unknown as JsonValue,
  }
}

export async function executeOffboardingPlan(
  args: OffboardingExecutionArgs,
  context: OperatorApplyContext,
  hooks: OffboardingExecutionHooks = {},
): Promise<OperatorApplyOutcome> {
  const database = context.database
  let execution: OffboardingExecutionView
  let facts
  try {
    execution = await beginOffboardingExecutionAction(
      {
        tenantId: args.tenantId,
        planId: args.planId,
        operationId: context.operationId,
        billingHandled: args.billingHandled,
        billingNote: args.billingNote,
        actor: context.actor,
        now: context.now,
      },
      database,
    )
    facts = await readOffboardingExecutionFacts(
      { tenantId: args.tenantId, planId: args.planId },
      database,
    )
  } catch (error) {
    throw mapOffboardingError(error)
  }
  const plannedTargets = facts.plan.revocationTargets
  const wasComplete = execution.status === 'COMPLETED'
  const env: StepEnvironment = {
    database,
    tenantId: args.tenantId,
    planId: args.planId,
    executionId: execution.id,
    venueIds: facts.plan.venueIds,
    actor: context.actor,
    proposalId: context.proposalId,
    operationId: context.operationId,
    now: context.now,
    billingHandled: execution.billingHandled,
    billingNote: execution.billingNote,
    plannedTargets,
  }

  const failed: Array<{ step: string; code: string }> = []
  if (!wasComplete) {
    for (const key of OFFBOARDING_EXECUTION_STEP_KEYS) {
      const recorded = execution.steps.find((step) => step.key === key)
      if (recorded && recorded.status !== 'PENDING' && recorded.status !== 'FAILED') continue
      try {
        await hooks.beforeStep?.(key)
        const runner = STEP_RUNNERS[key]
        const settlement: OffboardingStepSettlement = isStepPlanned(key, plannedTargets)
          ? await runner(env)
          : { status: 'SKIPPED', outcome: { reason: 'NOT_IN_PLAN' } }
        await settleOffboardingExecutionStepAction(
          {
            tenantId: args.tenantId,
            executionId: execution.id,
            planId: args.planId,
            key,
            settlement,
            ...(isEffectStep(key) ? { evidence: { venueIds: env.venueIds, plannedTargets } } : {}),
            actor: context.actor,
            now: context.now,
          },
          database,
        )
      } catch (error) {
        const code = errorCodeOf(error)
        await failOffboardingExecutionStepAction(
          { tenantId: args.tenantId, executionId: execution.id, key, errorCode: code },
          database,
        )
        failed.push({ step: key, code })
        // Stop at the first failure: later steps assume the earlier ones held.
        break
      }
    }
  }

  if (failed.length > 0) {
    throw Object.assign(new Error(OFFBOARDING_SUMMARY.partial), {
      code: 'PARTIALLY_APPLIED',
      summary: `${OFFBOARDING_SUMMARY.partial} Failed step: ${failed[0]!.step} (${failed[0]!.code}).`,
    })
  }

  await assertLivePostconditions(env)

  await completeOffboardingExecutionAction(
    {
      tenantId: args.tenantId,
      executionId: execution.id,
      planId: args.planId,
      actor: context.actor,
      now: context.now,
    },
    database,
  )
  const view = await readOffboardingExecutionAction(
    { tenantId: args.tenantId, planId: args.planId },
    database,
  )
  if (!view) throw new Error('The offboarding execution could not be read back.')
  return offboardingOutcome(view, wasComplete)
}

// ---------------------------------------------------------------------------
// Reinstate (revert)
// ---------------------------------------------------------------------------

/** What a person must switch back on by hand after a reinstatement. */
export const OFFBOARDING_MANUAL_RESTORE_STEPS = [
  'Routines stay off: enable each one again with routines.propose_enable (it needs a person).',
  'Report schedules and live-data feeds stay off: switch them on again in the dashboard.',
  'Revoked integration credentials and bridge sessions are not restored: issue new ones.',
  'Revoked operator connections are not restored: the person reconnects and consents again.',
  'Billing was never touched: if the paid arrangement was cancelled at the payment provider, restore it there.',
  'Identity provider: if members were removed there, add them back there.',
] as const

export async function reinstateOffboardingExecution(
  original: { id: string; targetTenantId: string | null; result: unknown },
  context: OperatorApplyContext,
): Promise<OperatorApplyOutcome> {
  const database = context.database
  const tenantId = original.targetTenantId
  const executionId = (original.result as { executionId?: unknown } | null)?.executionId
  if (!tenantId || typeof executionId !== 'string') {
    throw Object.assign(new Error('The original result is incomplete.'), { code: 'STALE' })
  }
  const execution = await database.offboardingExecution.findFirst({
    where: { id: executionId, tenantId },
    select: { id: true, planId: true, status: true, priorState: true },
  })
  if (!execution) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' })
  if (execution.status === 'IN_PROGRESS') {
    throw Object.assign(new Error('The offboarding is not complete.'), { code: 'STALE' })
  }
  const prior = execution.priorState as unknown as OffboardingPriorState
  let venuesReopened = 0
  let membershipsRestored = 0

  if (execution.status === 'COMPLETED') {
    for (const venue of prior.venues.filter((item) => item.isActive)) {
      const current = await database.venue.findFirst({
        where: { id: venue.id, tenantId },
        select: { isActive: true, updatedAt: true },
      })
      if (!current || current.isActive) continue
      await setVenueAvailabilityAction(
        {
          tenantId,
          venueId: venue.id,
          expectedUpdatedAt: current.updatedAt,
          enabled: true,
          reason: `Reinstated after offboarding. ${operatorReason(original.id)}`,
          actor: venueActor(context.actor, 'MANAGER'),
        },
        database,
      )
      venuesReopened += 1
    }
    const tenant = await database.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, updatedAt: true },
    })
    if (tenant && tenant.status !== prior.tenant.status) {
      await updateClientStatusAction(
        {
          tenantId,
          expectedUpdatedAt: tenant.updatedAt,
          status: prior.tenant.status,
          actor: { type: 'HUMAN', id: context.actor.id, role: 'PLATFORM_ADMIN' },
        },
        database,
      )
    }
    for (const status of ['ACTIVE', 'INVITED'] as const) {
      const ids = prior.memberships.filter((item) => item.status === status).map((item) => item.id)
      if (ids.length === 0) continue
      const restored = await database.tenantMembership.updateMany({
        where: { tenantId, id: { in: ids }, status: 'REMOVED' },
        data: { status },
      })
      membershipsRestored += restored.count
    }
    await markOffboardingExecutionReinstatedAction(
      {
        tenantId,
        executionId: execution.id,
        planId: execution.planId,
        actor: context.actor,
        now: context.now,
      },
      database,
    )
  }
  const state = { executionId: execution.id, tenantId, status: 'REINSTATED' as const }
  return {
    result: {
      ...state,
      venuesReopened,
      membershipsRestored,
      customerStatus: prior.tenant.status,
      manualSteps: [...OFFBOARDING_MANUAL_RESTORE_STEPS],
      summary:
        'Reinstated: venues reopened and local membership records restored. Identity-provider access is a manual step; routines, credentials and operator connections were not restored. See manualSteps.',
    },
    after: state as unknown as JsonValue,
  }
}
