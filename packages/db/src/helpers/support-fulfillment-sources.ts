import { db } from '../client'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]

export type SupportFulfillmentSourceReader = Pick<
  TransactionClient,
  'knowledgeChangeProposal' | 'supportRequestAuditEvent'
>

export class SupportFulfillmentSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupportFulfillmentSourceError'
  }
}

const MAX_SOURCES = 100

type Proposal = {
  id: string
  status: string
  packageHandoff: { venuePackageId: string } | null
  operationalUpdateHandoff: { id: string } | null
  producedByConflictResolution: {
    proposalId: string
    proposal: {
      id: string
      supportRequestId: string | null
      supportRequestVersion: number | null
      producedByConflictResolution: { id: string } | null
    } | null
  } | null
  supportRequestId: string | null
  supportRequestVersion: number | null
}

export type SupportFulfillmentSource = {
  proposalId: string
  sourceProposalId: string
  sourceRequestVersion: number
  replacementOfProposalId: string | null
  status: string
  packageHandoffVenuePackageId: string | null
  operationalUpdateHandoffId: string | null
}

export async function readSupportFulfillmentSources(
  client: SupportFulfillmentSourceReader,
  input: { tenantId: string; venueId: string; supportRequestId: string },
): Promise<SupportFulfillmentSource[]> {
  const proposals = (await client.knowledgeChangeProposal.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      OR: [
        { supportRequestId: input.supportRequestId },
        {
          producedByConflictResolution: {
            is: {
              proposal: {
                is: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  supportRequestId: input.supportRequestId,
                },
              },
            },
          },
        },
      ],
    },
    orderBy: { id: 'asc' },
    take: MAX_SOURCES + 1,
    select: {
      id: true,
      status: true,
      packageHandoff: { select: { venuePackageId: true } },
      operationalUpdateHandoff: { select: { id: true } },
      supportRequestId: true,
      supportRequestVersion: true,
      producedByConflictResolution: {
        select: {
          proposalId: true,
          proposal: {
            select: {
              id: true,
              supportRequestId: true,
              supportRequestVersion: true,
              producedByConflictResolution: { select: { id: true } },
            },
          },
        },
      },
    },
  })) as Proposal[]
  if (proposals.length > MAX_SOURCES)
    throw new SupportFulfillmentSourceError('Support content source proposal count exceeds 100.')

  const result: SupportFulfillmentSource[] = []
  for (const proposal of proposals) {
    let source: { id: string; requestVersion: number } | null = null
    if (
      proposal.supportRequestId === input.supportRequestId &&
      proposal.supportRequestVersion !== null
    ) {
      if (proposal.producedByConflictResolution)
        throw new SupportFulfillmentSourceError(
          'Conflict replacement lineage must have one source hop.',
        )
      source = { id: proposal.id, requestVersion: proposal.supportRequestVersion }
    } else {
      const original = proposal.producedByConflictResolution?.proposal
      if (original && original.id !== proposal.producedByConflictResolution?.proposalId)
        throw new SupportFulfillmentSourceError('Conflict replacement lineage is inconsistent.')
      if (original?.producedByConflictResolution)
        throw new SupportFulfillmentSourceError(
          'Conflict replacement lineage must have one source hop.',
        )
      if (
        original?.supportRequestId === input.supportRequestId &&
        original.supportRequestVersion !== null
      )
        source = { id: original.id, requestVersion: original.supportRequestVersion }
    }
    if (source)
      result.push({
        proposalId: proposal.id,
        sourceProposalId: source.id,
        sourceRequestVersion: source.requestVersion,
        replacementOfProposalId: proposal.producedByConflictResolution?.proposalId ?? null,
        status: proposal.status,
        packageHandoffVenuePackageId: proposal.packageHandoff?.venuePackageId ?? null,
        operationalUpdateHandoffId: proposal.operationalUpdateHandoff?.id ?? null,
      })
  }
  for (const source of new Map(result.map((item) => [item.sourceProposalId, item])).values()) {
    const frozen = await client.supportRequestAuditEvent.findUnique({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId_tenantId_venueId_requestVersion: {
          supportRequestId: input.supportRequestId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          requestVersion: source.sourceRequestVersion,
        },
      },
      select: { id: true },
    })
    if (!frozen)
      throw new SupportFulfillmentSourceError(
        'Exact support request version evidence is unavailable.',
      )
  }
  return result
}
