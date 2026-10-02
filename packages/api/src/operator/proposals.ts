import { createHash, randomUUID } from 'node:crypto'

import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import type {
  OperatorCapability,
  OperatorProposalStatus,
  OperatorWriteToolName,
} from '@pathfinder/contracts/operator-mcp'
import { logger } from '@pathfinder/config/logger'
import { db } from '@pathfinder/db'
import { ZodError } from 'zod'

import { writeOperatorAudit, type OperatorDatabase } from './audit'
import { admitAutoApply } from './admission'
import { readPolicyRevision, resolveAutonomy } from './autonomy'
import { OPERATOR_OAUTH_LIFETIMES, approveUrl, type OperatorServerConfig } from './config'
import {
  assertGrantCapability,
  assertTenantInGrant,
  OperatorCapabilityError,
  OperatorNotFoundError,
} from './grants'
import type { VerifiedOperatorGrant } from './oauth'
import { argsHash as hashArgs, sameHash } from './tokens'

// ---------------------------------------------------------------------------
// Kind interface (P5 copies the appearance reference kind)
// ---------------------------------------------------------------------------

export type OperatorHumanActor = Readonly<{ type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }>

export type OperatorKindContext = Readonly<{
  database: OperatorDatabase
  grant: VerifiedOperatorGrant
  now: Date
}>

export type OperatorApplyContext = OperatorKindContext &
  Readonly<{
    /** The approving human, or the consenting human for auto-approved proposals. */
    actor: OperatorHumanActor
    proposalId: string
    operationId: string
  }>

export type OperatorTarget = Readonly<{
  tenantId?: string
  venueId?: string
  /** Platform target such as a CRM organization ID. */
  ref?: string
}>

export type StoredOperatorProposal = Readonly<{
  id: string
  kind: string
  args: unknown
  beforeSnapshot: unknown
  afterSnapshot: unknown
  result: unknown
  targetTenantId: string | null
  targetVenueId: string | null
  targetRef: string | null
}>

export type OperatorApplyOutcome = Readonly<{
  result: Record<string, JsonValue>
  after: JsonValue
}>

export type OperatorReconcileOutcome =
  | Readonly<{ state: 'applied'; outcome: OperatorApplyOutcome }>
  | Readonly<{ state: 'not_applied' }>
  | Readonly<{ state: 'unknown' }>

/**
 * What a kind can prove, from canonical and provider state, about an apply whose outcome was not
 * recorded. `partially_applied` and `no_effect` are durable settled states; `unknown` leaves the
 * operation held for a person.
 */
export type OperatorUnknownResolution =
  | Readonly<{ state: 'applied'; outcome: OperatorApplyOutcome }>
  | Readonly<{
      state: 'partially_applied'
      result: Record<string, JsonValue>
      summary: string
    }>
  | Readonly<{ state: 'no_effect'; summary: string }>
  | Readonly<{ state: 'unknown'; summary?: string }>

/** Refusals a kind raises at propose time that the caller should see by name. */
export const OPERATOR_KIND_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'DO_NOT_CONTACT_LOCKED',
  'SENT_AT_IN_FUTURE',
  'INVALID_URL',
  'RECEIPT_CONFLICT',
  'ADDRESS_SUPPRESSED',
  'CONTENT_CHANGED',
  'ESCALATION_UNACKNOWLEDGED',
  'RELEASE_LIMIT',
  'RELEASE_DISABLED',
  'DISABLED',
  'SLUG_TAKEN',
  'UNRECONCILED_PRIOR_OPERATION',
])

/** Durable failure codes that make the effect of a FAILED operation first-class and queryable. */
export const OPERATOR_OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN'
export const OPERATOR_PARTIALLY_APPLIED = 'PARTIALLY_APPLIED'
export const OPERATOR_FAILED_NO_EFFECT = 'FAILED_NO_EFFECT'

/** How long one apply claim holds a proposal before it may be reconciled. */
export const OPERATOR_APPLY_LEASE_MS = 5 * 60 * 1000

/** Thrown by a kind when its target moved since the proposal; the proposal becomes STALE. */
export class OperatorStaleError extends Error {
  readonly code = 'STALE'
}

export type OperatorProposalKind<Args = unknown> = Readonly<{
  kind: string
  tool: Exclude<OperatorWriteToolName, 'operator.propose_plan' | 'operator.propose_revert'>
  capability: OperatorCapability
  /** Parses and bounds the tool arguments (the P2 zod input). */
  parse: (raw: unknown) => Args
  target: (args: Args) => OperatorTarget
  /** Extra scope checks beyond the tenant (e.g. the venue belongs to it). Throw NOT_FOUND. */
  authorize?: (args: Args, context: OperatorKindContext) => Promise<void>
  /** The version the proposer expects the target to be at when applied (null: no check). */
  targetVersion: (args: Args, context: OperatorKindContext) => Promise<string | null>
  /** The target's current version, compared with targetVersion under the apply claim. */
  currentVersion: (args: Args, context: OperatorKindContext) => Promise<string | null>
  /** Human-readable diff for the approval page. Never includes secrets. */
  describe: (args: Args) => Readonly<{ title: string; lines: readonly string[] }>
  snapshot: (args: Args, context: OperatorKindContext) => Promise<JsonValue>
  /** Calls the canonical domain action with the human actor. */
  apply: (args: Args, context: OperatorApplyContext) => Promise<OperatorApplyOutcome>
  /**
   * Decides from canonical state whether an interrupted apply took effect. Only a kind whose
   * domain write is atomic and leaves a findable receipt can answer `applied` or `not_applied`;
   * anything else must answer `unknown` (or omit this), and the operation is held for a human.
   */
  reconcile?: (args: Args, context: OperatorApplyContext) => Promise<OperatorReconcileOutcome>
  /**
   * Resolves an operation recorded as OUTCOME_UNKNOWN (or PARTIALLY_APPLIED) by looking, read-only,
   * at canonical state and the provider. It must never repeat an effect and never create a second
   * identity. Absent means the operation stays held for a person.
   */
  resolveUnknown?: (args: Args, context: OperatorApplyContext) => Promise<OperatorUnknownResolution>
  /** Undo for an APPLIED proposal of this kind; absent means the kind cannot be reverted. */
  revert?: (
    original: StoredOperatorProposal,
    context: OperatorApplyContext,
  ) => Promise<OperatorApplyOutcome>
}>

export class OperatorProposalError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_KIND'
      | 'OPERATION_ID_REUSED'
      | 'ARGS_HASH_MISMATCH'
      | 'NOT_PENDING'
      | 'PLAN_STEP'
      | 'NOT_CANCELLABLE'
      | 'NOT_REVERTIBLE'
      | 'NOT_RECORDED',
    message: string,
  ) {
    super(message)
  }
}

/** Kinds are heterogeneous in their argument type; the registry erases it at this one point. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOperatorProposalKind = OperatorProposalKind<any>

export type OperatorKindRegistry = ReadonlyMap<string, AnyOperatorProposalKind>

export function createKindRegistry(
  kinds: readonly AnyOperatorProposalKind[],
): OperatorKindRegistry {
  const byTool = new Map<string, AnyOperatorProposalKind>()
  for (const kind of kinds) {
    if (byTool.has(kind.tool)) throw new Error(`Duplicate operator proposal kind for ${kind.tool}`)
    byTool.set(kind.tool, kind)
  }
  return byTool
}

export function kindByName(registry: OperatorKindRegistry, name: string) {
  for (const kind of registry.values()) if (kind.kind === name) return kind
  return undefined
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type ProposalRow = NonNullable<
  Awaited<ReturnType<OperatorDatabase['operatorProposal']['findUnique']>>
>

export type OperatorWriteView = {
  proposalId: string
  status: OperatorProposalStatus
  argsHash: string
  approveUrl?: string
  result?: Record<string, unknown>
}

export function proposalView(row: ProposalRow, config: OperatorServerConfig): OperatorWriteView {
  return {
    proposalId: row.id,
    status: row.status,
    argsHash: row.argsHash,
    ...(row.status === 'PENDING' && row.planId === null
      ? { approveUrl: approveUrl(config, row.id) }
      : row.status === 'PENDING' && row.planId
        ? { approveUrl: approveUrl(config, row.planId) }
        : {}),
    ...(row.status === 'APPLIED' && row.result && typeof row.result === 'object'
      ? { result: row.result as Record<string, unknown> }
      : row.failureCode
        ? {
            result: {
              ...(row.result && typeof row.result === 'object'
                ? (row.result as Record<string, unknown>)
                : {}),
              failureCode: row.failureCode,
            },
          }
        : {}),
  }
}

/**
 * Bumped whenever a kind's behaviour changes in a way an approver would care about. It is part of
 * the preview digest, so an approval given under older semantics cannot apply under newer ones.
 */
export const OPERATOR_KIND_SEMANTICS_VERSION = 1

/**
 * What the approver actually saw: the kind, its semantics version, the human-readable diff and the
 * version of the target it was computed against. Approval is only valid while this still holds.
 */
export function previewDigestOf(
  kind: AnyOperatorProposalKind,
  args: unknown,
  targetVersion: string | null,
): string {
  return hashArgs({
    tool: kind.tool,
    args: {
      semantics: OPERATOR_KIND_SEMANTICS_VERSION,
      preview: kind.describe(args),
      targetVersion,
    },
  })
}

/** Arguments minus the idempotency key: the same change always has the same hash. */
export function proposalArgsHash(tool: string, args: Record<string, unknown>): string {
  const rest = { ...args }
  delete rest.operationId
  return hashArgs({ tool, args: rest })
}

export function derivedOperationId(parent: string, index: number): string {
  const hex = createHash('sha256').update(`${parent}:${index}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  )
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type OperatorServiceContext = Readonly<{
  config: OperatorServerConfig
  database?: OperatorDatabase
  grant: VerifiedOperatorGrant
  kinds: OperatorKindRegistry
  now: Date
  requestId: string
}>

export async function assertKindScope(
  kind: AnyOperatorProposalKind,
  args: unknown,
  context: OperatorKindContext,
): Promise<OperatorTarget> {
  assertGrantCapability(context.grant, kind.capability)
  const target = kind.target(args)
  if (target.tenantId !== undefined) {
    await assertTenantInGrant(context.grant, target.tenantId, context.database)
  }
  await kind.authorize?.(args, context)
  return target
}

/**
 * Errors a caller can act on by name. Anything else thrown before the proposal row exists is an
 * infrastructure failure: it is reported as NOT_RECORDED (proved no effect, no operation to look
 * up) rather than as an unknown outcome that points the caller at a record that was never made.
 */
function isClassifiedRefusal(error: unknown) {
  if (
    error instanceof OperatorNotFoundError ||
    error instanceof OperatorCapabilityError ||
    error instanceof OperatorProposalError ||
    error instanceof ZodError
  ) {
    return true
  }
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  return OPERATOR_KIND_REFUSAL_CODES.has(code)
}

export async function createProposal(
  tool: string,
  rawArgs: unknown,
  service: OperatorServiceContext,
): Promise<OperatorWriteView> {
  const database = service.database ?? db
  const kind = service.kinds.get(tool)
  if (!kind) throw new OperatorProposalError('UNKNOWN_KIND', 'Unknown proposal kind')
  const args = kind.parse(rawArgs) as Record<string, unknown> & { operationId: string }
  const context = { database, grant: service.grant, now: service.now }
  const argsHash = proposalArgsHash(tool, args)

  // Everything up to and including the INSERT happens before any effect. If it fails, no row
  // exists, so the caller must not be told to look the operation up: the failure is a proved
  // no-effect (NOT_RECORDED) that is safe to retry with the same operationId.
  let row: ProposalRow
  try {
    const target = await assertKindScope(kind, args, context)
    const existing = await database.operatorProposal.findUnique({
      where: {
        grantId_operationId: { grantId: service.grant.grantId, operationId: args.operationId },
      },
    })
    if (existing) return replayView(existing, argsHash, service.config)
    const targetVersion = await kind.targetVersion(args, context)
    const policyRevision = await readPolicyRevision(database)
    try {
      row = await database.operatorProposal.create({
        data: {
          grantId: service.grant.grantId,
          clientId: service.grant.clientId,
          operationId: args.operationId,
          kind: kind.kind,
          tool,
          capability: kind.capability,
          targetTenantId: target.tenantId ?? null,
          targetVenueId: target.venueId ?? null,
          targetRef: target.ref ?? null,
          args: args as object,
          argsHash,
          targetVersion,
          previewDigest: previewDigestOf(kind, args, targetVersion),
          policyRevision,
          expiresAt: new Date(
            service.now.getTime() + OPERATOR_OAUTH_LIFETIMES.proposalHours * 3_600_000,
          ),
          createdAt: service.now,
        },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const raced = await database.operatorProposal.findUnique({
        where: {
          grantId_operationId: { grantId: service.grant.grantId, operationId: args.operationId },
        },
      })
      if (!raced) throw error
      return replayView(raced, argsHash, service.config)
    }
  } catch (error) {
    if (isClassifiedRefusal(error)) throw error
    logger.error({
      action: 'operator.proposal.not_recorded',
      error: error instanceof Error ? error.name : 'unknown',
      requestId: service.requestId,
      tool,
      grantId: service.grant.grantId,
    })
    throw new OperatorProposalError(
      'NOT_RECORDED',
      'The change was not recorded and nothing was changed. It is safe to send the same request again.',
    )
  }

  // From here the operation is durable and can be looked up by its operationId. Nothing below may
  // throw the operation away: a failure now leaves the recorded state to speak for itself.
  try {
    await auditTransition(database, service.requestId, row, 'CREATED', null)
    // Automatic application spends a per-connection hourly budget. When it is spent the proposal
    // stays PENDING for a human; it never fails and never bypasses the limit.
    if (
      (await resolveAutonomy(kind, database)) === 'auto' &&
      (await admitAutoApply(database, service.grant.grantId, service.now)).allowed
    ) {
      await approveAndApplyProposal(
        {
          proposalId: row.id,
          argsHash,
          actorUserId: service.grant.userId,
          auto: true,
          requestId: service.requestId,
          now: service.now,
        },
        { database, kinds: service.kinds, allowedUserIds: service.config.allowedUserIds },
      )
    }
  } catch (error) {
    logger.error({
      action: 'operator.proposal.post_record_failure',
      error: error instanceof Error ? error.name : 'unknown',
      requestId: service.requestId,
      proposalId: row.id,
    })
  }
  try {
    row = (await database.operatorProposal.findUnique({ where: { id: row.id } })) ?? row
  } catch {
    // Report the row as it was recorded.
  }
  return proposalView(row, service.config)
}

function replayView(row: ProposalRow, argsHash: string, config: OperatorServerConfig) {
  if (!sameHash(row.argsHash, argsHash)) {
    throw new OperatorProposalError(
      'OPERATION_ID_REUSED',
      'This operationId was already used for different arguments.',
    )
  }
  return proposalView(row, config)
}

async function auditTransition(
  database: OperatorDatabase,
  requestId: string,
  row: Pick<
    ProposalRow,
    | 'id'
    | 'grantId'
    | 'clientId'
    | 'tool'
    | 'argsHash'
    | 'targetTenantId'
    | 'targetVenueId'
    | 'planId'
  >,
  outcome: string,
  actorUserId: string | null,
) {
  await writeOperatorAudit(
    {
      requestId,
      eventType: 'proposal.transition',
      outcome,
      grantId: row.grantId,
      clientId: row.clientId,
      tool: row.tool,
      argsHash: row.argsHash,
      targetTenantId: row.targetTenantId,
      targetVenueId: row.targetVenueId,
      proposalId: row.id,
      planId: row.planId,
      actorUserId,
    },
    database,
  )
}

// ---------------------------------------------------------------------------
// Approve, apply, reject, expire
// ---------------------------------------------------------------------------

export type OperatorDecisionDependencies = Readonly<{
  database?: OperatorDatabase
  kinds: OperatorKindRegistry
  /** Current approver allowlist; a grant whose owner left it can no longer apply anything. */
  allowedUserIds: ReadonlySet<string>
}>

type DecisionInput = Readonly<{
  proposalId: string
  /** The argsHash the human saw; the POST is bound to it. */
  argsHash: string
  actorUserId: string
  requestId: string
  now: Date
  auto?: boolean
}>

export async function loadGrant(
  database: OperatorDatabase,
  grantId: string,
  now: Date,
  allowedUserIds: ReadonlySet<string>,
) {
  const grant = await database.operatorGrant.findUnique({
    where: { id: grantId },
    include: { client: { select: { revokedAt: true } } },
  })
  if (!grant || grant.revokedAt !== null || grant.expiresAt <= now) return null
  // Revoking the connection (client) ends every grant under it, including work already queued.
  if (grant.client.revokedAt !== null) return null
  if (!allowedUserIds.has(grant.userId)) return null
  return {
    grantId: grant.id,
    clientId: grant.clientId,
    userId: grant.userId,
    allTenants: grant.allTenants,
    tenantIds: grant.tenantIds,
    capabilities: grant.capabilities as OperatorCapability[],
  } satisfies VerifiedOperatorGrant
}

async function expireIfDue(
  database: OperatorDatabase,
  row: ProposalRow,
  now: Date,
  requestId: string,
) {
  if (row.status !== 'PENDING' || row.expiresAt > now) return false
  const changed = await database.operatorProposal.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: { status: 'EXPIRED' },
  })
  if (changed.count === 1) await auditTransition(database, requestId, row, 'EXPIRED', null)
  return true
}

/**
 * Human (or auto-policy) approval of one standalone proposal, then apply. Replays are no-ops:
 * only the first PENDING→APPROVED compare-and-set wins, and only one apply claim can succeed.
 */
export async function approveAndApplyProposal(
  input: DecisionInput,
  dependencies: OperatorDecisionDependencies,
): Promise<ProposalRow> {
  const database = dependencies.database ?? db
  const row = await database.operatorProposal.findUnique({ where: { id: input.proposalId } })
  if (!row) throw new OperatorNotFoundError()
  if (row.planId !== null) {
    throw new OperatorProposalError('PLAN_STEP', 'Plan steps are approved with their plan.')
  }
  if (row.status !== 'PENDING') return row
  if (await expireIfDue(database, row, input.now, input.requestId)) {
    return (await database.operatorProposal.findUnique({ where: { id: row.id } }))!
  }
  if (!sameHash(row.argsHash, input.argsHash)) {
    throw new OperatorProposalError(
      'ARGS_HASH_MISMATCH',
      'The proposal changed since it was shown.',
    )
  }
  const approved = await database.operatorProposal.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      decidedByUserId: input.actorUserId,
      decidedAt: input.now,
      autoApproved: input.auto === true,
    },
  })
  if (approved.count !== 1) {
    return (await database.operatorProposal.findUnique({ where: { id: row.id } }))!
  }
  await auditTransition(
    database,
    input.requestId,
    row,
    input.auto ? 'AUTO_APPROVED' : 'APPROVED',
    input.actorUserId,
  )
  return applyApprovedProposal(row.id, input, dependencies)
}

export async function finish(
  database: OperatorDatabase,
  row: ProposalRow,
  status: 'APPLIED' | 'FAILED' | 'STALE',
  data: {
    beforeSnapshot?: JsonValue
    afterSnapshot?: JsonValue
    result?: JsonValue
    failureCode?: string
    appliedAt?: Date
    args?: JsonValue
    /** The domain action refused atomically, so no write began: clear the "may have started" mark. */
    clearStarted?: boolean
  },
  requestId: string,
  actorUserId: string,
) {
  // Fenced: only the claim that still holds the lease may record the result. A stale worker whose
  // lease was taken over finds the token changed and records nothing.
  const recorded = await database.operatorProposal.updateMany({
    where: { id: row.id, status: 'APPROVED', fenceToken: row.fenceToken },
    data: {
      status,
      ...(data.beforeSnapshot !== undefined
        ? { beforeSnapshot: data.beforeSnapshot as object }
        : {}),
      ...(data.afterSnapshot !== undefined ? { afterSnapshot: data.afterSnapshot as object } : {}),
      ...(data.result !== undefined ? { result: data.result as object } : {}),
      ...(data.args !== undefined ? { args: data.args as object } : {}),
      failureCode: data.failureCode ?? null,
      appliedAt: data.appliedAt ?? null,
      leaseExpiresAt: null,
      ...(data.clearStarted ? { applyStartedAt: null } : {}),
    },
  })
  if (recorded.count === 1) {
    await auditTransition(
      database,
      requestId,
      row,
      status === 'FAILED' ? `FAILED:${data.failureCode ?? ''}` : status,
      actorUserId,
    )
  }
  return (await database.operatorProposal.findUnique({ where: { id: row.id } }))!
}

function failureCode(error: unknown): string {
  if (error instanceof OperatorNotFoundError) return 'NOT_FOUND'
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code)
    if (/^[A-Z0-9_:-]{1,60}$/u.test(code)) return code
  }
  return 'APPLY_FAILED'
}

/**
 * A canonical domain action that rejects its input does so inside its own transaction, which then
 * rolls back: nothing was written. Those refusals are the only errors that prove "no effect".
 */
function isAtomicRefusal(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return (
    [
      'ProspectActionError',
      'VenueActionError',
      'ProspectOutreachError',
      'SupportActionError',
    ].includes(error.name) &&
    [
      'NOT_FOUND',
      'INVALID_INPUT',
      'CONFLICT',
      'SUPPRESSED',
      'APPROVAL_REQUIRED',
      'RELEASE_DISABLED',
    ].includes(String(code))
  )
}

function isStale(error: unknown) {
  if (error instanceof OperatorStaleError) return true
  // Canonical domain actions report optimistic-concurrency loss as CONFLICT.
  return (
    error instanceof Error &&
    (error.name === 'VenueActionError' ||
      error.name === 'ProspectActionError' ||
      error.name === 'ProspectOutreachError' ||
      error.name === 'SupportActionError') &&
    (error as Error & { code?: unknown }).code === 'CONFLICT'
  )
}

/**
 * Applies an APPROVED proposal exactly once. `resolvedArgs` lets a plan substitute earlier step
 * outputs; the stored argsHash still binds what the human approved.
 */
export async function applyApprovedProposal(
  proposalId: string,
  input: Pick<DecisionInput, 'actorUserId' | 'requestId' | 'now'> & { resolvedArgs?: unknown },
  dependencies: OperatorDecisionDependencies,
): Promise<ProposalRow> {
  const database = dependencies.database ?? db
  const claimed = await database.operatorProposal.updateMany({
    where: { id: proposalId, status: 'APPROVED', applyClaimedAt: null },
    data: {
      applyClaimedAt: input.now,
      leaseExpiresAt: new Date(input.now.getTime() + OPERATOR_APPLY_LEASE_MS),
      applyStartedAt: null,
      fenceToken: { increment: 1 },
      attempt: { increment: 1 },
    },
  })
  const row = (await database.operatorProposal.findUnique({ where: { id: proposalId } }))!
  if (claimed.count !== 1) return row
  const grant = await loadGrant(database, row.grantId, input.now, dependencies.allowedUserIds)
  if (!grant)
    return finish(
      database,
      row,
      'FAILED',
      { failureCode: 'GRANT_REVOKED' },
      input.requestId,
      input.actorUserId,
    )
  const context: OperatorApplyContext = {
    database,
    grant,
    now: input.now,
    actor: { type: 'HUMAN', id: input.actorUserId, role: 'PLATFORM_ADMIN' },
    proposalId: row.id,
    operationId: row.operationId,
  }
  let applyBegan = false
  let resolvableLater = false
  try {
    if (row.kind === 'operator.revert') {
      return await applyRevert(row, context, dependencies, input)
    }
    const kind = kindByName(dependencies.kinds, row.kind)
    if (!kind)
      return finish(
        database,
        row,
        'FAILED',
        { failureCode: 'UNKNOWN_KIND' },
        input.requestId,
        input.actorUserId,
      )
    resolvableLater = kind.resolveUnknown !== undefined
    const args = kind.parse(input.resolvedArgs ?? row.args)
    await assertKindScope(kind, args, context)
    // The approval covered a specific preview. If what this code would show for the stored
    // arguments is no longer what was approved (a new release changed the semantics, or the
    // target moved), the approval does not carry over: a fresh preview is required.
    if (row.previewDigest !== null && input.resolvedArgs === undefined) {
      const current = previewDigestOf(kind, kind.parse(row.args), row.targetVersion)
      if (current !== row.previewDigest) {
        return finish(
          database,
          row,
          'STALE',
          { failureCode: 'PREVIEW_CHANGED' },
          input.requestId,
          input.actorUserId,
        )
      }
    }
    const expected =
      row.targetVersion ?? (input.resolvedArgs ? await kind.targetVersion(args, context) : null)
    if (expected !== null && (await kind.currentVersion(args, context)) !== expected) {
      return finish(
        database,
        row,
        'STALE',
        { failureCode: 'TARGET_CHANGED' },
        input.requestId,
        input.actorUserId,
      )
    }
    const before = await kind.snapshot(args, context)
    // From here a domain write may begin. Recording that first, under the fence, is what lets a
    // later reconciler say "never started" or "may have committed" instead of guessing.
    const started = await database.operatorProposal.updateMany({
      where: { id: row.id, status: 'APPROVED', fenceToken: row.fenceToken },
      data: { applyStartedAt: input.now },
    })
    if (started.count !== 1) {
      return (await database.operatorProposal.findUnique({ where: { id: row.id } }))!
    }
    applyBegan = true
    const outcome = await kind.apply(args, context)
    return finish(
      database,
      row,
      'APPLIED',
      {
        beforeSnapshot: before,
        afterSnapshot: outcome.after,
        result: outcome.result,
        appliedAt: input.now,
        ...(input.resolvedArgs !== undefined ? { args: args as JsonValue } : {}),
      },
      input.requestId,
      input.actorUserId,
    )
  } catch (error) {
    if (isStale(error)) {
      return finish(
        database,
        row,
        'STALE',
        { failureCode: 'TARGET_CHANGED', clearStarted: true },
        input.requestId,
        input.actorUserId,
      )
    }
    const summary = failureSummaryOf(error)
    // A kind that can reconcile records an interrupted apply as a first-class OUTCOME_UNKNOWN
    // (with the cause kept in the result) so it is found, held and resolved, never retried blind.
    if (applyBegan && resolvableLater && !isProvedNoEffect(error)) {
      return finish(
        database,
        row,
        'FAILED',
        {
          failureCode: OPERATOR_OUTCOME_UNKNOWN,
          result: { cause: failureCode(error), ...(summary ? { summary } : {}) },
        },
        input.requestId,
        input.actorUserId,
      )
    }
    return finish(
      database,
      row,
      'FAILED',
      {
        failureCode: failureCode(error),
        ...(summary ? { result: { summary } } : {}),
        ...(isProvedNoEffect(error) ? { clearStarted: true } : {}),
      },
      input.requestId,
      input.actorUserId,
    )
  }
}

/**
 * A kind that failed before reaching anything outside its own bookkeeping marks the error, so the
 * operation is recorded as "no effect" instead of "unknown".
 */
function isProvedNoEffect(error: unknown) {
  return (
    isAtomicRefusal(error) ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { provedNoEffect?: unknown }).provedNoEffect === true)
  )
}

/** A business-language statement of what a failed apply did and did not do, if the kind gave one. */
function failureSummaryOf(error: unknown): string | undefined {
  const summary =
    typeof error === 'object' && error !== null
      ? (error as { summary?: unknown }).summary
      : undefined
  return typeof summary === 'string' && summary.length > 0 ? summary.slice(0, 500) : undefined
}

async function applyRevert(
  row: ProposalRow,
  context: OperatorApplyContext,
  dependencies: OperatorDecisionDependencies,
  input: Pick<DecisionInput, 'actorUserId' | 'requestId' | 'now'>,
) {
  const database = context.database
  const originalId = (row.args as { proposalId?: unknown }).proposalId
  const original =
    typeof originalId === 'string'
      ? await database.operatorProposal.findUnique({ where: { id: originalId } })
      : null
  const kind = original ? kindByName(dependencies.kinds, original.kind) : undefined
  if (!original || original.status !== 'APPLIED' || !kind?.revert) {
    return finish(
      database,
      row,
      'FAILED',
      { failureCode: 'NOT_REVERTIBLE' },
      input.requestId,
      input.actorUserId,
    )
  }
  if (original.targetTenantId) {
    await assertTenantInGrant(context.grant, original.targetTenantId, database)
  }
  const started = await database.operatorProposal.updateMany({
    where: { id: row.id, status: 'APPROVED', fenceToken: row.fenceToken },
    data: { applyStartedAt: input.now },
  })
  if (started.count !== 1) {
    return (await database.operatorProposal.findUnique({ where: { id: row.id } }))!
  }
  const outcome = await kind.revert(original, context)
  return finish(
    database,
    row,
    'APPLIED',
    {
      beforeSnapshot: original.afterSnapshot as JsonValue,
      afterSnapshot: outcome.after,
      result: outcome.result,
      appliedAt: input.now,
    },
    input.requestId,
    input.actorUserId,
  )
}

export async function rejectProposal(
  input: Pick<DecisionInput, 'proposalId' | 'actorUserId' | 'requestId' | 'now'>,
  database: OperatorDatabase = db,
): Promise<ProposalRow> {
  const row = await database.operatorProposal.findUnique({ where: { id: input.proposalId } })
  if (!row) throw new OperatorNotFoundError()
  if (row.planId !== null) throw new OperatorProposalError('PLAN_STEP', 'Reject the plan instead.')
  const changed = await database.operatorProposal.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: { status: 'REJECTED', decidedByUserId: input.actorUserId, decidedAt: input.now },
  })
  if (changed.count === 1)
    await auditTransition(database, input.requestId, row, 'REJECTED', input.actorUserId)
  return (await database.operatorProposal.findUnique({ where: { id: row.id } }))!
}

/** Sweep for the dashboard: PENDING proposals and plans past 72 h become EXPIRED. */
export async function expireOperatorProposals(now: Date, database: OperatorDatabase = db) {
  const [proposals, plans] = await Promise.all([
    database.operatorProposal.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    }),
    database.operatorPlan.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    }),
  ])
  return { proposals: proposals.count, plans: plans.count }
}

// ---------------------------------------------------------------------------
// Revert proposals
// ---------------------------------------------------------------------------

export async function createRevertProposal(
  rawArgs: unknown,
  parse: (raw: unknown) => { proposalId: string; operationId: string },
  service: OperatorServiceContext,
): Promise<OperatorWriteView> {
  const database = service.database ?? db
  assertGrantCapability(service.grant, 'operator:revert')
  const args = parse(rawArgs)
  const original = await database.operatorProposal.findUnique({ where: { id: args.proposalId } })
  // A proposal from another grant or tenant outside this grant looks exactly like a missing one.
  if (!original || original.grantId !== service.grant.grantId) throw new OperatorNotFoundError()
  if (original.targetTenantId) {
    await assertTenantInGrant(service.grant, original.targetTenantId, database)
  }
  const kind = kindByName(service.kinds, original.kind)
  if (original.status !== 'APPLIED' || !kind?.revert) {
    throw new OperatorProposalError(
      'NOT_REVERTIBLE',
      'Only applied, revertible proposals can be reverted.',
    )
  }
  const argsHash = proposalArgsHash('operator.propose_revert', args)
  const existing = await database.operatorProposal.findUnique({
    where: {
      grantId_operationId: { grantId: service.grant.grantId, operationId: args.operationId },
    },
  })
  if (existing) return replayView(existing, argsHash, service.config)
  const row = await database.operatorProposal.create({
    data: {
      grantId: service.grant.grantId,
      clientId: service.grant.clientId,
      operationId: args.operationId,
      kind: 'operator.revert',
      tool: 'operator.propose_revert',
      capability: 'operator:revert',
      targetTenantId: original.targetTenantId,
      targetVenueId: original.targetVenueId,
      targetRef: original.id,
      args: args as object,
      argsHash,
      targetVersion: null,
      revertOfId: original.id,
      expiresAt: new Date(
        service.now.getTime() + OPERATOR_OAUTH_LIFETIMES.proposalHours * 3_600_000,
      ),
      createdAt: service.now,
    },
  })
  await auditTransition(database, service.requestId, row, 'CREATED', null)
  // Reverts are always-ask; resolveAutonomy returns ask for them whatever the policy rows say.
  return proposalView(row, service.config)
}

export function newRequestId() {
  return randomUUID()
}
