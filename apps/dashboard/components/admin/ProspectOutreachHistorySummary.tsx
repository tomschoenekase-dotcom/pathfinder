import type { ProspectOutreachHistoryProjection } from '@pathfinder/db'

export const OUTREACH_VIEWS = {
  neverContacted: 'Never contacted',
  firstFollowupDue: 'First follow-up due',
  finalFollowupDue: 'Final follow-up due',
  inConversation: 'In conversation',
  deferred: 'Deferred',
  stopped: 'Stopped',
  historyNeedsReview: 'History needs review',
} as const
export type OutreachView = keyof typeof OUTREACH_VIEWS

function date(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
        ...(new Date(value).getUTCFullYear() !== new Date().getUTCFullYear()
          ? { year: 'numeric' as const }
          : {}),
      })
    : 'Unknown'
}
const healthLabels = {
  healthy: 'Verified / current',
  unverified: 'Needs review',
  bounced: 'Bounced',
  suppressed: 'Suppressed',
  policyBlocked: 'Policy-blocked',
  unknown: 'Unknown',
}
const reasonLabels: Record<string, string> = {
  eligible: 'Ready for the next outreach step',
  declined: 'The recipient declined',
  customer: 'Existing customer; use the customer relationship',
  closed: 'Relationship closed',
  deferred: 'Outreach deferred',
  inConversation: 'Human conversation; use a reviewed reply',
  contact_healthy: 'Contact verified',
  contact_unverified: 'Contact needs review',
  contact_bounced: 'Address bounced; review contact',
  contact_suppressed: 'Contact is suppressed',
  contact_policyBlocked: 'Contact blocked by policy',
  contact_unknown: 'Contact health needs review',
  history_incomplete: 'Outreach history needs review',
  unresolved: 'Account identity needs review',
  existing_unsent_draft: 'An unsent draft already exists',
  cold_sequence_complete: 'Three cold emails sent; sequence complete',
  cooldown: 'Follow-up interval has not elapsed',
}
function reason(value: string) {
  return reasonLabels[value] ?? value.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
}
const replyLabels = {
  after1: 'After email 1',
  after2: 'After email 2',
  after3: 'After email 3',
  otherUnknown: 'Other / unknown',
  noReply: 'No reply',
}
const relationships = {
  prospect: 'Prospect',
  awaitingReply: 'Awaiting reply',
  inConversation: 'In conversation',
  deferred: 'Deferred',
  declined: 'Declined',
  customer: 'Customer',
  closed: 'Closed',
}
export function ProspectOutreachHistorySummary({
  history,
  detail = false,
}: {
  history?: ProspectOutreachHistoryProjection
  detail?: boolean
}) {
  if (!history)
    return <p className="text-xs text-slate-600">Outreach history unavailable · hold for review</p>
  return (
    <div className="min-w-0 space-y-1 text-xs leading-5 text-slate-600">
      <p className="font-semibold text-slate-900">
        {history.coldEmailCount === null
          ? 'Unknown cold-email count'
          : `${history.coldEmailCount} sent`}{' '}
        ·{' '}
        {history.firstHumanReply === 'noReply' ? 'no reply' : replyLabels[history.firstHumanReply]}
        {history.nextEligibleAt ? ` · due ${date(history.nextEligibleAt)}` : ''}
      </p>
      <p>
        {relationships[history.relationship]} ·{' '}
        <span className="font-semibold">{history.eligibility}</span> ·{' '}
        {reason(history.eligibilityReason)}
      </p>
      {detail ? (
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div>
            <dt className="inline font-medium">Cold emails sent: </dt>
            <dd className="inline">{history.coldEmailCount ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Last cold email: </dt>
            <dd className="inline">{date(history.lastColdEmailAt)}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Contact health: </dt>
            <dd className="inline">{healthLabels[history.contactHealth]}</dd>
          </div>
          <div>
            <dt className="inline font-medium">First human reply: </dt>
            <dd className="inline">{replyLabels[history.firstHumanReply]}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Next eligible: </dt>
            <dd className="inline">
              {history.nextEligibleAt ? date(history.nextEligibleAt) : 'Not scheduled'}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">History: </dt>
            <dd className="inline">
              {history.historyComplete ? 'Complete for this projection' : 'Needs review'}
            </dd>
          </div>
          {history.reasons.length ? (
            <div className="sm:col-span-2">
              <dt className="inline font-medium">Review notes: </dt>
              <dd className="inline">{history.reasons.map(reason).join('; ')}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p>
          Last cold email: {date(history.lastColdEmailAt)} · Contact:{' '}
          {healthLabels[history.contactHealth]}
        </p>
      )}
    </div>
  )
}
