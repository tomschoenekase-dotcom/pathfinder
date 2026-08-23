import type { Prisma } from '@prisma/client'

const agentActionEvidenceQuery = (take: number) =>
  ({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: {
      id: true,
      agentIdentityId: true,
      actionName: true,
      status: true,
      errorCode: true,
      createdAt: true,
      agentIdentity: { select: { id: true, name: true } },
    },
  }) satisfies Prisma.AgentActionFindManyArgs

const approvalDecisionEvidenceQuery = (take: number) =>
  ({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: {
      id: true,
      decision: true,
      createdAt: true,
      approvalRequest: {
        select: {
          agentIdentityId: true,
          proposedAction: true,
          agentIdentity: { select: { id: true, name: true } },
        },
      },
    },
  }) satisfies Prisma.ApprovalDecisionFindManyArgs

export async function readAgentEvidenceRows(
  database: Pick<typeof import('@pathfinder/db').db, 'agentAction' | 'approvalDecision'>,
  take: number,
) {
  const [actions, approvalDecisions] = await Promise.all([
    database.agentAction.findMany(agentActionEvidenceQuery(take)),
    database.approvalDecision.findMany(approvalDecisionEvidenceQuery(take)),
  ])
  return { actions, approvalDecisions }
}
