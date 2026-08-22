import { db } from '../client'

type Client = typeof db
type GroupRow = { _count: { _all: number } } & Record<string, unknown>

function groups(rows: readonly GroupRow[], key: string): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [String(row[key]), row._count._all]))
}

/** Outcome-oriented CRM metrics. Opens are intentionally absent. */
export async function getProspectOutreachAnalyticsAction(
  input: { campaignId?: string },
  client: Client = db,
) {
  const campaignId = input.campaignId
  const organizationScope = campaignId ? { campaignMembers: { some: { campaignId } } } : undefined
  const [
    sendStates,
    messageDirections,
    opportunityStages,
    permissionStates,
    contactReadiness,
    followupStates,
    draftStates,
    researchStates,
    meetings,
  ] = await Promise.all([
    client.prospectSendItem.groupBy({
      by: ['status'],
      ...(campaignId ? { where: { batch: { campaignId } } } : {}),
      _count: { _all: true },
    }),
    client.prospectEmailMessage.groupBy({
      by: ['direction'],
      ...(organizationScope ? { where: { organization: organizationScope } } : {}),
      _count: { _all: true },
    }),
    client.prospectOpportunity.groupBy({
      by: ['stage'],
      ...(organizationScope ? { where: { organization: organizationScope } } : {}),
      _count: { _all: true },
    }),
    client.prospectContact.groupBy({
      by: ['permissionState'],
      ...(campaignId ? { where: { campaignMembers: { some: { campaignId } } } } : {}),
      _count: { _all: true },
    }),
    client.prospectContact.groupBy({
      by: ['emailReadiness'],
      ...(campaignId ? { where: { campaignMembers: { some: { campaignId } } } } : {}),
      _count: { _all: true },
    }),
    client.prospectFollowup.groupBy({
      by: ['status'],
      ...(campaignId ? { where: { campaignMember: { campaignId } } } : {}),
      _count: { _all: true },
    }),
    client.prospectOutreachDraft.groupBy({
      by: ['status'],
      ...(campaignId ? { where: { campaignId } } : {}),
      _count: { _all: true },
    }),
    client.prospectResearchJob.groupBy({
      by: ['status'],
      ...(organizationScope ? { where: { organization: organizationScope } } : {}),
      _count: { _all: true },
    }),
    client.companyMeeting.count({
      where: {
        organizationId: { not: null },
        ...(organizationScope ? { organization: organizationScope } : {}),
      },
    }),
  ])
  const sends = groups(sendStates, 'status')
  const messages = groups(messageDirections, 'direction')
  const opportunities = groups(opportunityStages, 'stage')
  const permissions = groups(permissionStates, 'permissionState')
  return {
    campaignId: campaignId ?? null,
    delivery: sends,
    replies: messages.INBOUND ?? 0,
    meetings,
    conversions: opportunities.WON ?? 0,
    qualified: opportunities.QUALIFIED ?? 0,
    optOuts: permissions.OPTED_OUT ?? 0,
    complaints: sends.COMPLAINED ?? 0,
    suppressions: sends.SUPPRESSED ?? 0,
    followups: groups(followupStates, 'status'),
    draftQuality: groups(draftStates, 'status'),
    researchQuality: groups(researchStates, 'status'),
    sourceContactQuality: {
      permission: permissions,
      emailReadiness: groups(contactReadiness, 'emailReadiness'),
    },
  }
}
