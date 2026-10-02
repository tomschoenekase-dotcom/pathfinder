import { db } from '@pathfinder/db'

import { writeOperatorAudit, type OperatorDatabase } from './audit'
import { isAlwaysAskKind, OPERATOR_LOCKED_CAPABILITIES } from './autonomy'
import { OperatorNotFoundError } from './grants'
import {
  approveAndApplyProposal,
  OperatorProposalError,
  type AnyOperatorProposalKind,
  type OperatorKindRegistry,
} from './proposals'
import { sameHash } from './tokens'

/**
 * Bounded job grants: an owner's advance, narrow permission for one named job to have specific
 * proposal kinds applied from a signed-in review page within the job's bounds.
 *
 * Authority rules, all enforced here and not in any caller:
 * - Created and revoked only through `createJobGrant` / `revokeJobGrant`, which the dashboard route
 *   calls behind a signed-in, allowlisted platform admin, same-origin check and strict
 *   reverification. No operator tool reaches them, so the operator connection can never mint,
 *   widen, spend or revoke a grant. The authenticated review route matches the grant on the server
 *   from the proposal's own kind, tenant, venue and amount.
 * - A kind is grantable only if it opts in (`jobGrant` on the kind). Default deny. Always-ask kinds
 *   and locked capabilities are never grantable, so mail, invites and billing stay behind a person.
 * - Every bound is part of one conditional UPDATE (`claimJobGrantUse`), so concurrent proposals
 *   cannot overspend a count or an amount, and a revoked or expired grant cannot be used.
 * - Anything that does not match is refused and the proposal stays PENDING for normal approval.
 */
export const OPERATOR_JOB_GRANT_LIMITS = {
  defaultHours: 24,
  minMinutes: 5,
  maxHours: 168,
  maxExecutions: 100,
  maxKinds: 10,
  maxAmountCents: 100_000_000,
} as const

export type OperatorJobGrantErrorCode =
  | 'INVALID'
  | 'KIND_NOT_GRANTABLE'
  | 'FORBIDDEN_ACTOR'
  | 'CLIENT_NOT_FOUND'
  | 'SCOPE_NOT_FOUND'
  | 'NO_MATCHING_GRANT'

export class OperatorJobGrantError extends Error {
  constructor(
    readonly code: OperatorJobGrantErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Whether a kind may sit under a job grant at all. */
export function isJobGrantableKind(kind: AnyOperatorProposalKind): boolean {
  return (
    kind.jobGrant !== undefined &&
    !isAlwaysAskKind(kind.kind) &&
    !OPERATOR_LOCKED_CAPABILITIES.has(kind.capability)
  )
}

export function listJobGrantableKinds(kinds: OperatorKindRegistry) {
  return [...kinds.values()]
    .filter(isJobGrantableKind)
    .map((kind) => ({
      kind: kind.kind,
      tool: kind.tool,
      capability: kind.capability,
      carriesAmount: kind.jobGrant?.amountCents !== undefined,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

type Dependencies = Readonly<{
  database?: OperatorDatabase
  kinds: OperatorKindRegistry
  /** The operator approver allowlist; the acting person must still be on it. */
  allowedUserIds: ReadonlySet<string>
}>

function assertActor(userId: string, allowedUserIds: ReadonlySet<string>) {
  if (!allowedUserIds.has(userId)) {
    throw new OperatorJobGrantError('FORBIDDEN_ACTOR', 'This account may not manage job grants.')
  }
}

export type CreateJobGrantInput = Readonly<{
  name: string
  /** The operator connection (OAuth client) the grant applies to. */
  clientId: string
  tenantId: string
  /** Omitted covers every venue of the tenant. */
  venueId?: string | undefined
  kinds: readonly string[]
  maxExecutions: number
  maxAmountCents?: number | undefined
  expiresInMinutes?: number | undefined
  actorUserId: string
  requestId: string
  now: Date
}>

export async function createJobGrant(input: CreateJobGrantInput, dependencies: Dependencies) {
  const database = dependencies.database ?? db
  assertActor(input.actorUserId, dependencies.allowedUserIds)
  const name = input.name.trim()
  if (name.length < 1 || name.length > 120) {
    throw new OperatorJobGrantError('INVALID', 'The job needs a name of up to 120 characters.')
  }
  const kindNames = [...new Set(input.kinds)]
  if (kindNames.length < 1 || kindNames.length > OPERATOR_JOB_GRANT_LIMITS.maxKinds) {
    throw new OperatorJobGrantError('INVALID', 'Choose between one and ten kinds.')
  }
  if (
    !Number.isInteger(input.maxExecutions) ||
    input.maxExecutions < 1 ||
    input.maxExecutions > OPERATOR_JOB_GRANT_LIMITS.maxExecutions
  ) {
    throw new OperatorJobGrantError('INVALID', 'The execution limit is out of range.')
  }
  const minutes = input.expiresInMinutes ?? OPERATOR_JOB_GRANT_LIMITS.defaultHours * 60
  if (
    !Number.isInteger(minutes) ||
    minutes < OPERATOR_JOB_GRANT_LIMITS.minMinutes ||
    minutes > OPERATOR_JOB_GRANT_LIMITS.maxHours * 60
  ) {
    throw new OperatorJobGrantError('INVALID', 'The expiry is out of range.')
  }
  const maxAmount = input.maxAmountCents
  if (
    maxAmount !== undefined &&
    (!Number.isInteger(maxAmount) ||
      maxAmount < 0 ||
      maxAmount > OPERATOR_JOB_GRANT_LIMITS.maxAmountCents)
  ) {
    throw new OperatorJobGrantError('INVALID', 'The amount limit is out of range.')
  }
  for (const kindName of kindNames) {
    const kind = [...dependencies.kinds.values()].find((entry) => entry.kind === kindName)
    if (!kind || !isJobGrantableKind(kind)) {
      throw new OperatorJobGrantError('KIND_NOT_GRANTABLE', 'That kind cannot be granted.')
    }
    // An amount cap only means something for a kind that can state the amount of each use.
    if (maxAmount !== undefined && kind.jobGrant?.amountCents === undefined) {
      throw new OperatorJobGrantError('INVALID', 'That kind carries no amount to cap.')
    }
  }
  const client = await database.operatorOAuthClient.findUnique({
    where: { id: input.clientId },
    select: { revokedAt: true, consentedAt: true, expiresAt: true },
  })
  if (
    !client ||
    client.revokedAt !== null ||
    client.consentedAt === null ||
    (client.expiresAt !== null && client.expiresAt <= input.now)
  ) {
    throw new OperatorJobGrantError('CLIENT_NOT_FOUND', 'That connection is not active.')
  }
  const tenant = await database.tenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true },
  })
  if (!tenant) throw new OperatorJobGrantError('SCOPE_NOT_FOUND', 'That client was not found.')
  if (input.venueId !== undefined) {
    const venue = await database.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new OperatorJobGrantError('SCOPE_NOT_FOUND', 'That venue was not found.')
  }
  const expiresAt = new Date(input.now.getTime() + minutes * 60_000)
  const row = await database.operatorJobGrant.create({
    data: {
      name,
      clientId: input.clientId,
      createdByUserId: input.actorUserId,
      targetTenantId: input.tenantId,
      targetVenueId: input.venueId ?? null,
      allowedKinds: kindNames.sort(),
      maxExecutions: input.maxExecutions,
      remainingExecutions: input.maxExecutions,
      maxAmountCents: maxAmount ?? null,
      remainingAmountCents: maxAmount ?? null,
      expiresAt,
      createdAt: input.now,
    },
  })
  await writeOperatorAudit(
    {
      requestId: input.requestId,
      eventType: 'job_grant.change',
      outcome: 'CREATED',
      clientId: input.clientId,
      targetTenantId: input.tenantId,
      targetVenueId: input.venueId ?? null,
      actorUserId: input.actorUserId,
      args: {
        jobGrantId: row.id,
        name,
        kinds: row.allowedKinds,
        maxExecutions: row.maxExecutions,
        maxAmountCents: row.maxAmountCents,
        expiresAt: expiresAt.toISOString(),
      },
    },
    database,
  )
  return row
}

export async function revokeJobGrant(
  input: Readonly<{ id: string; actorUserId: string; requestId: string; now: Date }>,
  dependencies: Pick<Dependencies, 'database' | 'allowedUserIds'>,
) {
  const database = dependencies.database ?? db
  assertActor(input.actorUserId, dependencies.allowedUserIds)
  const existing = await database.operatorJobGrant.findUnique({ where: { id: input.id } })
  if (!existing) throw new OperatorNotFoundError()
  // Idempotent: revoking twice keeps the first revocation and records only the first.
  const changed = await database.operatorJobGrant.updateMany({
    where: { id: input.id, revokedAt: null },
    data: { revokedAt: input.now, revokedByUserId: input.actorUserId },
  })
  if (changed.count === 1) {
    await writeOperatorAudit(
      {
        requestId: input.requestId,
        eventType: 'job_grant.change',
        outcome: 'REVOKED',
        clientId: existing.clientId,
        targetTenantId: existing.targetTenantId,
        targetVenueId: existing.targetVenueId,
        actorUserId: input.actorUserId,
        args: { jobGrantId: existing.id, name: existing.name },
      },
      database,
    )
  }
  return database.operatorJobGrant.findUniqueOrThrow({ where: { id: input.id } })
}

export type ClaimedJobGrant = Readonly<{ id: string; name: string; createdByUserId: string }>

/**
 * Spends one use of a matching job grant, or returns null. The match is on the proposal's own
 * kind, tenant, venue and connection; the bounds are re-checked by the same UPDATE that spends
 * them. A use is consumed once it is claimed even if the change later turns out stale or fails:
 * the safe direction for a budget.
 */
export async function claimJobGrantUse(
  database: OperatorDatabase,
  input: Readonly<{
    kind: AnyOperatorProposalKind
    args: unknown
    clientId: string
    tenantId: string | null
    venueId: string | null
    now: Date
    allowedUserIds: ReadonlySet<string>
  }>,
): Promise<ClaimedJobGrant | null> {
  // A kind must opt in, and a proposal with no tenant target can never match a tenant-scoped grant.
  if (!isJobGrantableKind(input.kind) || input.tenantId === null) return null
  let amount = 0
  const amountOf = input.kind.jobGrant?.amountCents
  if (amountOf) {
    try {
      amount = amountOf(input.args)
    } catch {
      return null
    }
    if (!Number.isInteger(amount) || amount < 0) return null
  }
  const candidates = await database.operatorJobGrant.findMany({
    where: {
      clientId: input.clientId,
      targetTenantId: input.tenantId,
      revokedAt: null,
      expiresAt: { gt: input.now },
      remainingExecutions: { gt: 0 },
      allowedKinds: { has: input.kind.kind },
      createdByUserId: { in: [...input.allowedUserIds] },
      client: { revokedAt: null },
      OR: [
        { targetVenueId: null },
        ...(input.venueId !== null ? [{ targetVenueId: input.venueId }] : []),
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 5,
    select: {
      id: true,
      name: true,
      createdByUserId: true,
      maxAmountCents: true,
      remainingAmountCents: true,
    },
  })
  for (const candidate of candidates) {
    const capped = candidate.maxAmountCents !== null
    if (capped && (candidate.remainingAmountCents ?? 0) < amount) continue
    const claimed = await database.operatorJobGrant.updateMany({
      where: {
        id: candidate.id,
        revokedAt: null,
        expiresAt: { gt: input.now },
        remainingExecutions: { gt: 0 },
        ...(capped ? { remainingAmountCents: { gte: amount } } : {}),
      },
      data: {
        remainingExecutions: { decrement: 1 },
        ...(capped && amount > 0 ? { remainingAmountCents: { decrement: amount } } : {}),
      },
    })
    if (claimed.count === 1) {
      return { id: candidate.id, name: candidate.name, createdByUserId: candidate.createdByUserId }
    }
  }
  return null
}

/**
 * A signed-in owner explicitly spends one grant use on an existing pending proposal. The MCP
 * proposal path never calls this service: possession of a connection token does not spend a job
 * grant or turn a pending proposal into an approval. The route supplies an authenticated actor.
 */
export async function applyPendingWithJobGrant(
  input: Readonly<{
    proposalId: string
    argsHash: string
    actorUserId: string
    requestId: string
    now: Date
  }>,
  dependencies: Dependencies,
) {
  const database = dependencies.database ?? db
  assertActor(input.actorUserId, dependencies.allowedUserIds)
  const proposal = await database.operatorProposal.findUnique({ where: { id: input.proposalId } })
  if (!proposal) throw new OperatorNotFoundError()
  if (
    proposal.planId !== null ||
    proposal.status !== 'PENDING' ||
    proposal.expiresAt <= input.now
  ) {
    throw new OperatorProposalError('NOT_PENDING', 'This proposal is no longer pending.')
  }
  if (!sameHash(proposal.argsHash, input.argsHash)) {
    throw new OperatorProposalError(
      'ARGS_HASH_MISMATCH',
      'The proposal changed since it was shown.',
    )
  }
  const kind = [...dependencies.kinds.values()].find((entry) => entry.kind === proposal.kind)
  if (!kind || !isJobGrantableKind(kind)) {
    throw new OperatorJobGrantError('KIND_NOT_GRANTABLE', 'That kind cannot be granted.')
  }
  const use = await claimJobGrantUse(database, {
    kind,
    args: proposal.args,
    clientId: proposal.clientId,
    tenantId: proposal.targetTenantId,
    venueId: proposal.targetVenueId,
    now: input.now,
    // The person pressing Apply may spend only a grant they personally created.
    allowedUserIds: new Set([input.actorUserId]),
  })
  if (!use) {
    throw new OperatorJobGrantError(
      'NO_MATCHING_GRANT',
      'No active job grant covers this proposal.',
    )
  }
  return approveAndApplyProposal(
    {
      proposalId: proposal.id,
      argsHash: input.argsHash,
      actorUserId: input.actorUserId,
      jobGrantId: use.id,
      requestId: input.requestId,
      now: input.now,
    },
    dependencies,
  )
}

export type OperatorJobGrantView = {
  id: string
  name: string
  clientId: string
  clientName: string
  tenantId: string
  tenantName: string | null
  venueId: string | null
  kinds: string[]
  maxExecutions: number
  remainingExecutions: number
  maxAmountCents: number | null
  remainingAmountCents: number | null
  expiresAt: Date
  revokedAt: Date | null
  createdAt: Date
  status: 'active' | 'expired' | 'revoked' | 'exhausted'
}

/** Read-only list for the dashboard, newest first. Nothing here is reachable from the operator. */
export async function listJobGrants(
  now: Date,
  database: OperatorDatabase = db,
): Promise<OperatorJobGrantView[]> {
  const rows = await database.operatorJobGrant.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { client: { select: { clientName: true } } },
  })
  const tenants = rows.length
    ? await database.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.targetTenantId))] } },
        select: { id: true, name: true },
      })
    : []
  const tenantName = new Map(tenants.map((tenant) => [tenant.id, tenant.name]))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    clientName: row.client.clientName,
    tenantId: row.targetTenantId,
    tenantName: tenantName.get(row.targetTenantId) ?? null,
    venueId: row.targetVenueId,
    kinds: row.allowedKinds,
    maxExecutions: row.maxExecutions,
    remainingExecutions: row.remainingExecutions,
    maxAmountCents: row.maxAmountCents,
    remainingAmountCents: row.remainingAmountCents,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    status: row.revokedAt
      ? 'revoked'
      : row.expiresAt <= now
        ? 'expired'
        : row.remainingExecutions <= 0 ||
            (row.remainingAmountCents !== null && row.remainingAmountCents <= 0)
          ? 'exhausted'
          : 'active',
  }))
}
