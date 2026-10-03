import { db } from '@pathfinder/db'

import { writeOperatorAudit, type OperatorDatabase } from './audit'
import { decisionUrl, OPERATOR_OAUTH_LIFETIMES, type OperatorServerConfig } from './config'
import { assertTenantInGrant, OperatorNotFoundError } from './grants'
import type { VerifiedOperatorGrant } from './oauth'
import {
  approveAndApplyProposal,
  OperatorProposalError,
  rejectProposal,
  type OperatorKindRegistry,
} from './proposals'
import { sameHash } from './tokens'

/**
 * Authenticated chat approvals.
 *
 * A chat surface (the operator connection) can only REQUEST that a person decide one proposal:
 * `requestDecision` records a short-lived, single-use ticket bound to the proposal's exact version
 * (args hash, preview digest, target version) and hands back a link. It confers no authority. The
 * decision itself is `decideRequest`, which only the dashboard route handler calls, behind a
 * signed-in, allowlisted platform admin with same-origin and strict reverification checks. No
 * operator tool imports it (a test pins that), so the connection can neither mint nor consume an
 * approval. The approval and rejection themselves reuse the existing proposal services.
 */

export type OperatorDecisionState = 'requested' | 'decided' | 'expired' | 'invalidated'

export type OperatorDecisionRequestView = {
  proposalId: string
  proposalStatus: string
  /** Null when no request exists for this proposal yet and none can be made (it is not pending). */
  requestId: string | null
  state: OperatorDecisionState | null
  decision: 'approve' | 'reject' | null
  /** Where a signed-in person decides. Present only while the request is open. */
  decisionUrl?: string
  expiresAt?: string
  /** The proposal's status after the decision was applied, once decided. */
  resultStatus?: string
}

type RequestRow = NonNullable<
  Awaited<ReturnType<OperatorDatabase['operatorDecisionRequest']['findUnique']>>
>
type ProposalRow = NonNullable<
  Awaited<ReturnType<OperatorDatabase['operatorProposal']['findUnique']>>
>

const STATE: Record<RequestRow['status'], OperatorDecisionState> = {
  REQUESTED: 'requested',
  DECIDED: 'decided',
  EXPIRED: 'expired',
  INVALIDATED: 'invalidated',
}

function viewOf(
  proposal: Pick<ProposalRow, 'id' | 'status'>,
  request: RequestRow | null,
  config: Pick<OperatorServerConfig, 'issuer'>,
  now: Date,
): OperatorDecisionRequestView {
  if (!request) {
    return {
      proposalId: proposal.id,
      proposalStatus: proposal.status,
      requestId: null,
      state: null,
      decision: null,
    }
  }
  // An open request past its time is reported as expired even before a sweep records it.
  const state =
    request.status === 'REQUESTED' && request.expiresAt <= now ? 'expired' : STATE[request.status]
  return {
    proposalId: proposal.id,
    proposalStatus: proposal.status,
    requestId: request.id,
    state,
    decision:
      request.decision === 'approve' || request.decision === 'reject' ? request.decision : null,
    ...(state === 'requested'
      ? {
          decisionUrl: decisionUrl(config, proposal.id, request.id),
          expiresAt: request.expiresAt.toISOString(),
        }
      : {}),
    ...(request.resultStatus ? { resultStatus: request.resultStatus } : {}),
  }
}

function sameVersion(request: RequestRow, proposal: ProposalRow): boolean {
  return (
    sameHash(request.argsHash, proposal.argsHash) &&
    request.previewDigest === proposal.previewDigest &&
    request.targetVersion === proposal.targetVersion
  )
}

async function audit(
  database: OperatorDatabase,
  requestId: string,
  outcome: string,
  proposal: ProposalRow,
  request: Pick<RequestRow, 'id'>,
  actorUserId: string | null,
  grant?: Pick<VerifiedOperatorGrant, 'grantId' | 'clientId'>,
) {
  await writeOperatorAudit(
    {
      requestId,
      eventType: 'decision.request',
      outcome,
      grantId: grant?.grantId ?? proposal.grantId,
      clientId: grant?.clientId ?? proposal.clientId,
      tool: proposal.tool,
      argsHash: proposal.argsHash,
      targetTenantId: proposal.targetTenantId,
      targetVenueId: proposal.targetVenueId,
      proposalId: proposal.id,
      actorUserId,
      args: { decisionRequestId: request.id },
    },
    database,
  )
}

// ---------------------------------------------------------------------------
// Chat side: request and render. Confers no authority.
// ---------------------------------------------------------------------------

export type RequestDecisionContext = Readonly<{
  config: Pick<OperatorServerConfig, 'issuer'>
  database: OperatorDatabase
  grant: VerifiedOperatorGrant
  now: Date
  requestId: string
}>

/**
 * Asks for a person to decide one of this connection's own pending proposals, or reports where an
 * earlier request stands. Repeating the call is the way to render the result: it returns the same
 * open ticket, or the recorded decision. It never approves, rejects or applies anything.
 */
export async function requestDecision(
  proposalId: string,
  context: RequestDecisionContext,
): Promise<OperatorDecisionRequestView> {
  const { database, grant, now } = context
  const proposal = await database.operatorProposal.findUnique({ where: { id: proposalId } })
  // Another connection's proposal, or a tenant outside this grant, looks exactly like a missing one.
  if (!proposal || proposal.grantId !== grant.grantId) throw new OperatorNotFoundError()
  if (proposal.planId !== null) {
    throw new OperatorProposalError('PLAN_STEP', 'Plan steps are approved with their plan.')
  }
  if (proposal.targetTenantId) await assertTenantInGrant(grant, proposal.targetTenantId, database)

  const latest = () =>
    database.operatorDecisionRequest.findFirst({
      where: { proposalId: proposal.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
  if (proposal.status !== 'PENDING' || proposal.expiresAt <= now) {
    return viewOf(proposal, await latest(), context.config, now)
  }

  await database.operatorDecisionRequest.updateMany({
    where: { proposalId: proposal.id, status: 'REQUESTED', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  })
  const open = await database.operatorDecisionRequest.findMany({
    where: { proposalId: proposal.id, status: 'REQUESTED' },
    orderBy: { createdAt: 'desc' },
  })
  const current = open.find((request) => sameVersion(request, proposal))
  // A ticket for a version that is no longer the proposal's can never be used.
  const stale = open.filter((request) => request !== current)
  if (stale.length > 0) {
    await database.operatorDecisionRequest.updateMany({
      where: { id: { in: stale.map((request) => request.id) }, status: 'REQUESTED' },
      data: { status: 'INVALIDATED' },
    })
  }
  if (current) return viewOf(proposal, current, context.config, now)

  const created = await database.operatorDecisionRequest.create({
    data: {
      proposalId: proposal.id,
      grantId: grant.grantId,
      clientId: grant.clientId,
      argsHash: proposal.argsHash,
      previewDigest: proposal.previewDigest,
      targetVersion: proposal.targetVersion,
      expiresAt: new Date(now.getTime() + OPERATOR_OAUTH_LIFETIMES.decisionRequestMinutes * 60_000),
      createdAt: now,
    },
  })
  await audit(database, context.requestId, 'REQUESTED', proposal, created, null, grant)
  return viewOf(proposal, created, context.config, now)
}

// ---------------------------------------------------------------------------
// Human side: decide. Called only by the dashboard route handler after its guards.
// ---------------------------------------------------------------------------

export type DecideRequestInput = Readonly<{
  decisionRequestId: string
  /** The argsHash the person saw on screen. */
  argsHash: string
  decision: 'approve' | 'reject'
  actorUserId: string
  /** Correlates audit rows with the HTTP request. */
  requestId: string
  now: Date
}>

export type DecideRequestDependencies = Readonly<{
  database?: OperatorDatabase
  kinds: OperatorKindRegistry
  /** The operator approver allowlist; the deciding person must be on it. */
  allowedUserIds: ReadonlySet<string>
}>

/**
 * Consumes one decision request exactly once and applies the decision through the existing
 * approval service. Order matters: every check that can refuse comes before the single
 * compare-and-set that spends the ticket, and the proposal is only touched after it is spent, so
 * a replay, a race or a retry can never decide twice.
 *
 * Callers must already have verified the signed-in session, allowlist, origin and reverification;
 * the allowlist is checked again here so the service is safe on its own.
 */
export async function decideRequest(
  input: DecideRequestInput,
  dependencies: DecideRequestDependencies,
) {
  const database = dependencies.database ?? db
  if (!dependencies.allowedUserIds.has(input.actorUserId)) {
    throw new OperatorProposalError('FORBIDDEN_ACTOR', 'This account may not decide.')
  }
  const request = await database.operatorDecisionRequest.findUnique({
    where: { id: input.decisionRequestId },
  })
  if (!request) throw new OperatorNotFoundError()
  const proposal = await database.operatorProposal.findUnique({ where: { id: request.proposalId } })
  if (!proposal) throw new OperatorNotFoundError()

  if (request.status === 'EXPIRED') {
    throw new OperatorProposalError('REQUEST_EXPIRED', 'This request has expired.')
  }
  if (request.status === 'INVALIDATED') {
    throw new OperatorProposalError(
      'REQUEST_INVALIDATED',
      'The proposal changed after this request.',
    )
  }
  if (request.status !== 'REQUESTED') {
    throw new OperatorProposalError('REQUEST_USED', 'This request was already decided.')
  }
  if (request.expiresAt <= input.now) {
    const expired = await database.operatorDecisionRequest.updateMany({
      where: { id: request.id, status: 'REQUESTED' },
      data: { status: 'EXPIRED' },
    })
    if (expired.count === 1) {
      await audit(database, input.requestId, 'EXPIRED', proposal, request, input.actorUserId)
    }
    throw new OperatorProposalError('REQUEST_EXPIRED', 'This request has expired.')
  }
  // What the person was shown must be exactly what the ticket was issued for.
  if (!sameHash(request.argsHash, input.argsHash)) {
    throw new OperatorProposalError(
      'ARGS_HASH_MISMATCH',
      'The proposal changed since it was shown.',
    )
  }
  // A proposal that changed, was decided elsewhere or left the pending state voids the ticket.
  if (
    proposal.planId !== null ||
    proposal.status !== 'PENDING' ||
    !sameVersion(request, proposal)
  ) {
    const voided = await database.operatorDecisionRequest.updateMany({
      where: { id: request.id, status: 'REQUESTED' },
      data: { status: 'INVALIDATED' },
    })
    if (voided.count === 1) {
      await audit(database, input.requestId, 'INVALIDATED', proposal, request, input.actorUserId)
    }
    throw new OperatorProposalError(
      'REQUEST_INVALIDATED',
      'The proposal changed after this request.',
    )
  }

  // The single-use compare-and-set. Only one caller can move REQUESTED to DECIDED.
  const spent = await database.operatorDecisionRequest.updateMany({
    where: { id: request.id, status: 'REQUESTED', expiresAt: { gt: input.now } },
    data: {
      status: 'DECIDED',
      decision: input.decision,
      decidedByUserId: input.actorUserId,
      decidedAt: input.now,
    },
  })
  if (spent.count !== 1) {
    throw new OperatorProposalError('REQUEST_USED', 'This request was already decided.')
  }
  await audit(
    database,
    input.requestId,
    `DECIDED:${input.decision}`,
    proposal,
    request,
    input.actorUserId,
  )

  let result: ProposalRow | undefined
  try {
    result =
      input.decision === 'approve'
        ? await approveAndApplyProposal(
            {
              proposalId: proposal.id,
              argsHash: request.argsHash,
              actorUserId: input.actorUserId,
              requestId: input.requestId,
              now: input.now,
            },
            dependencies,
          )
        : await rejectProposal(
            {
              proposalId: proposal.id,
              actorUserId: input.actorUserId,
              requestId: input.requestId,
              now: input.now,
            },
            database,
          )
    return result
  } finally {
    await database.operatorDecisionRequest
      .update({
        where: { id: request.id },
        data: { resultStatus: result?.status ?? 'ERROR' },
      })
      .catch(() => undefined)
  }
}

/** What the approval page needs to render an open request; a dead or foreign one reads as null. */
export async function readDecisionRequestForPage(
  decisionRequestId: string,
  proposalId: string,
  now: Date,
  database: OperatorDatabase = db,
) {
  const request = await database.operatorDecisionRequest.findFirst({
    where: { id: decisionRequestId, proposalId },
    select: { id: true, status: true, argsHash: true, expiresAt: true },
  })
  if (!request) return null
  return {
    id: request.id,
    argsHash: request.argsHash,
    expiresAt: request.expiresAt,
    open: request.status === 'REQUESTED' && request.expiresAt > now,
    status: request.status,
  }
}
