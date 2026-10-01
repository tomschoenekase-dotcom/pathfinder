import { createHash, randomUUID } from 'node:crypto'

import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import type {
  OperatorCapability,
  OperatorProposalStatus,
  OperatorWriteToolName,
} from '@pathfinder/contracts/operator-mcp'
import { db } from '@pathfinder/db'

import { writeOperatorAudit, type OperatorDatabase } from './audit'
import { resolveAutonomy } from './autonomy'
import { OPERATOR_OAUTH_LIFETIMES, approveUrl, type OperatorServerConfig } from './config'
import { assertGrantCapability, assertTenantInGrant, OperatorNotFoundError } from './grants'
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
      | 'NOT_REVERTIBLE',
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

function kindByName(registry: OperatorKindRegistry, name: string) {
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
        ? { result: { failureCode: row.failureCode } }
        : {}),
  }
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
  const target = await assertKindScope(kind, args, context)
  const argsHash = proposalArgsHash(tool, args)
  const existing = await database.operatorProposal.findUnique({
    where: {
      grantId_operationId: { grantId: service.grant.grantId, operationId: args.operationId },
    },
  })
  if (existing) return replayView(existing, argsHash, service.config)
  let row: ProposalRow
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
        targetVersion: await kind.targetVersion(args, context),
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
  await auditTransition(database, service.requestId, row, 'CREATED', null)
  if ((await resolveAutonomy(kind, database)) === 'auto') {
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
    row = (await database.operatorProposal.findUnique({ where: { id: row.id } }))!
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

async function loadGrant(
  database: OperatorDatabase,
  grantId: string,
  now: Date,
  allowedUserIds: ReadonlySet<string>,
) {
  const grant = await database.operatorGrant.findUnique({ where: { id: grantId } })
  if (!grant || grant.revokedAt !== null || grant.expiresAt <= now) return null
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

async function finish(
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
  },
  requestId: string,
  actorUserId: string,
) {
  await database.operatorProposal.updateMany({
    where: { id: row.id, status: 'APPROVED' },
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
    },
  })
  await auditTransition(
    database,
    requestId,
    row,
    status === 'FAILED' ? `FAILED:${data.failureCode ?? ''}` : status,
    actorUserId,
  )
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

function isStale(error: unknown) {
  if (error instanceof OperatorStaleError) return true
  // Canonical domain actions report optimistic-concurrency loss as CONFLICT.
  return (
    error instanceof Error &&
    (error.name === 'VenueActionError' || error.name === 'ProspectActionError') &&
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
    data: { applyClaimedAt: input.now },
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
    const args = kind.parse(input.resolvedArgs ?? row.args)
    await assertKindScope(kind, args, context)
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
        { failureCode: 'TARGET_CHANGED' },
        input.requestId,
        input.actorUserId,
      )
    }
    return finish(
      database,
      row,
      'FAILED',
      { failureCode: failureCode(error) },
      input.requestId,
      input.actorUserId,
    )
  }
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
