import type { Prisma } from '@prisma/client'
import type { db } from '@pathfinder/db'
import type { ProspectOutreachHistoryProjection } from '@pathfinder/db'

export const prospectOutreachViews = {
  neverContacted: 'Never contacted',
  firstFollowupDue: 'First follow-up due',
  finalFollowupDue: 'Final follow-up due',
  inConversation: 'In conversation',
  deferred: 'Deferred',
  stopped: 'Stopped',
  historyNeedsReview: 'History needs review',
} as const

export function matchesProspectOutreachView(
  history: ProspectOutreachHistoryProjection,
  view: keyof typeof prospectOutreachViews,
) {
  switch (view) {
    case 'neverContacted':
      return (
        history.historyComplete &&
        history.coldEmailCount === 0 &&
        history.relationship === 'prospect'
      )
    case 'firstFollowupDue':
      return (
        history.eligibility === 'eligible' &&
        history.coldEmailCount === 1 &&
        history.firstHumanReply === 'noReply'
      )
    case 'finalFollowupDue':
      return (
        history.eligibility === 'eligible' &&
        history.coldEmailCount === 2 &&
        history.firstHumanReply === 'noReply'
      )
    case 'inConversation':
      return history.relationship === 'inConversation'
    case 'deferred':
      return history.relationship === 'deferred'
    case 'stopped':
      return history.eligibility === 'stopped'
    case 'historyNeedsReview':
      return !history.historyComplete || history.coldEmailCount === null
  }
}

/** Coarse admission only; complete evidence is required, never inferred from activity totals. */
export async function outreachCompleteCandidateWhere(
  reader: Pick<typeof db, 'prospectActivity'>,
): Promise<Prisma.ProspectOrganizationWhereInput> {
  const completeWhere = {
    AND: [
      { evidence: { path: ['schema'], equals: 'prospect-outreach-history/v1' } },
      { evidence: { path: ['kind'], equals: 'complete' } },
    ],
  }
  if ((await reader.prospectActivity.count({ where: completeWhere })) === 0)
    return { id: { in: [] } }
  // Explicit parent scopes may name an account whose own activity is empty.
  const scopes = await reader.prospectActivity.findMany({
    where: {
      AND: [
        { evidence: { path: ['schema'], equals: 'prospect-outreach-history/v1' } },
        { evidence: { path: ['kind'], equals: 'scope' } },
      ],
    },
    select: { evidence: true },
  })
  const scopedIds = scopes.flatMap((row) => {
    const evidence = row.evidence as { organizationIds?: unknown } | null
    return Array.isArray(evidence?.organizationIds)
      ? evidence.organizationIds.filter((id): id is string => typeof id === 'string')
      : []
  })
  return {
    OR: [
      { activities: { some: completeWhere } },
      { id: { in: scopedIds } },
      { mergedIntoOrganizationId: { not: null } },
      { mergedSources: { some: {} } },
    ],
  }
}
