import { createHash } from 'node:crypto'

import { TRPCError } from '@trpc/server'

import type { ContentEvidenceReference } from '@pathfinder/contracts/content-model'

import type { TRPCContext } from '../context'

type ScopedDb = TRPCContext['db']
type Scope = { tenantId: string; venueId: string; proposalId: string }

const proposalSelect = {
  id: true,
  supportRequestId: true,
  supportRequestVersion: true,
  evidenceMessageIds: true,
  producedByConflictResolution: { select: { proposalId: true } },
} as const

function precondition(message: string): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message })
}

function evidenceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20)
    precondition('Support evidence must contain between one and twenty message IDs.')
  if (
    value.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(value).size !== value.length
  )
    precondition('Support evidence message IDs must be unique nonempty strings.')
  return value
}

/**
 * Resolves frozen support-message provenance for one scoped support proposal or its conflict
 * replacement. It reads no raw evidence into its result and never changes proposal state.
 */
export async function resolveSupportProposalContentEvidence(params: {
  db: ScopedDb
  tenantId: string
  venueId: string
  proposalId: string
}): Promise<ContentEvidenceReference[]> {
  const scope: Scope = {
    tenantId: params.tenantId,
    venueId: params.venueId,
    proposalId: params.proposalId,
  }
  const proposal = await params.db.knowledgeChangeProposal.findFirst({
    where: { id: scope.proposalId, tenantId: scope.tenantId, venueId: scope.venueId },
    select: proposalSelect,
  })
  if (!proposal)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge proposal not found.' })

  const source = proposal.producedByConflictResolution
    ? await params.db.knowledgeChangeProposal.findFirst({
        where: {
          id: proposal.producedByConflictResolution.proposalId,
          tenantId: scope.tenantId,
          venueId: scope.venueId,
        },
        select: proposalSelect,
      })
    : proposal
  if (!source)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Original support proposal not found.' })
  if (proposal.producedByConflictResolution && source.producedByConflictResolution)
    precondition('Conflict replacement lineage must resolve to one original proposal.')
  if (!source.supportRequestId || source.supportRequestVersion === null)
    precondition('The proposal has no frozen support request provenance.')

  const ids = evidenceIds(source.evidenceMessageIds)
  const supportRequest = await params.db.supportRequest.findFirst({
    where: {
      id: source.supportRequestId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
    },
    select: { id: true },
  })
  if (!supportRequest)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request provenance not found.' })
  const frozen = await params.db.supportRequestAuditEvent.findUnique({
    where: {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      supportRequestId_tenantId_venueId_requestVersion: {
        supportRequestId: supportRequest.id,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        requestVersion: source.supportRequestVersion,
      },
    },
    select: { id: true },
  })
  if (!frozen) precondition('Exact support request version evidence is unavailable.')

  const messages = await params.db.supportMessage.findMany({
    where: {
      id: { in: ids },
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      supportRequestId: supportRequest.id,
      requestVersion: { not: null, lte: source.supportRequestVersion },
    },
    select: { id: true, body: true, createdAt: true },
  })
  const byId = new Map(messages.map((message) => [message.id, message]))
  if (byId.size !== ids.length)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Every evidence message must belong to the frozen support request scope.',
    })

  return ids.map((id) => {
    const message = byId.get(id)!
    return {
      sourceId: `support-message:${message.id}`,
      locator: `support-request:${supportRequest.id}`,
      capturedAt: message.createdAt.toISOString(),
      excerptHash: createHash('sha256').update(message.body, 'utf8').digest('hex'),
    }
  })
}
