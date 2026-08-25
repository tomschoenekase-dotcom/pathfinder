import Link from 'next/link'

import type {
  SupportRequestCategory,
  SupportRequestStatus,
} from '@pathfinder/contracts/support-workflow'

import { SupportMessageComposer } from './SupportMessageComposer'
import { SupportPackageHandoffForm } from './SupportPackageHandoffForm'
import { ReviewedVenuePackageDraftForm } from './ReviewedVenuePackageDraftForm'
import { SupportStatusTransitionForm } from './SupportStatusTransitionForm'
import { SupportTriageForm } from './SupportTriageForm'
import { SupportVersionBoundActions } from './SupportVersionBoundActions'
import { SupportAgentRunLineagePanel, type SupportRunLineage } from './SupportAgentRunLineagePanel'
import { SupportKnowledgeProposalForm } from './SupportKnowledgeProposalForm'

type Cursor = Record<string, string | number> | null
type RequestItem = {
  id: string
  category: SupportRequestCategory
  missingInformation: string[]
  status: SupportRequestStatus
  subject: string
  version: number
  createdByKind: string
  updatedByKind: string
  createdAt: Date
  updatedAt: Date
}
type Message = {
  id: string
  authorKind: string
  visibility: string
  body: string
  requestVersion: number | null
  createdAt: Date
  attachments: { id: string; filename: string; mediaType: string; byteSize: string }[]
}
type Audit = {
  id: string
  requestVersion: number
  eventType: string
  actorKind: string
  fromStatus: string | null
  toStatus: string | null
  createdAt: Date
}
type Page<T> = { items: T[]; nextCursor: Cursor }
type DraftPackage = {
  id: string
  schemaVersion: number
  payloadHash: string
  createdBy: string
  createdAt: Date
}
type Handoff = {
  id: string
  venuePackageId: string
  requestVersion: number
  linkedByKind: string
  linkedById: string
  createdAt: Date
  venuePackage: { status: string; schemaVersion: number; payloadHash: string }
  supersessionAsPrior: {
    id: string
    replacementHandoffId: string
    requestVersion: number
    createdAt: Date
  } | null
  supersessionsAsReplacement: {
    id: string
    supersededHandoffId: string
    requestVersion: number
    createdAt: Date
  }[]
}
type KnowledgeProposalLineage = {
  id: string
  status: string
  supportRequestId: string | null
  supportRequestVersion: number | null
  proposedChange: string
  reason: string
  evidenceMessageIds: unknown
  createdByType: string
  createdAt: Date
}
type EligibleAttachment = {
  intakeUploadId: string
  fileName: string
  mimeType: string
  byteSize: number
  createdAt: Date | string
}
type Props = {
  tenantId: string
  venueId: string
  requests: Page<RequestItem>
  selected: RequestItem | null
  messages: Page<Message>
  audit: Page<Audit>
  draftPackages?: DraftPackage[]
  handoffs?: Handoff[]
  eligibleAttachments?: EligibleAttachment[]
  eligibleAttachmentsNextCursor?: { createdAt: string; id: string } | null
  runLineages?: SupportRunLineage[]
  runLineagesNextCursor?: { createdAt: string; id: string } | null
  knowledgeProposals?: KnowledgeProposalLineage[]
}

function query(
  base: string,
  requestId: string | null,
  prefix: string,
  cursor: Exclude<Cursor, null>,
) {
  const params = new URLSearchParams()
  if (requestId) params.set('requestId', requestId)
  for (const [key, value] of Object.entries(cursor))
    params.set(`${prefix}${key[0]!.toUpperCase()}${key.slice(1)}`, String(value))
  return `${base}?${params}`
}

export function SupportOperationsView({
  tenantId,
  venueId,
  requests,
  selected,
  messages,
  audit,
  draftPackages = [],
  handoffs = [],
  eligibleAttachments = [],
  eligibleAttachmentsNextCursor = null,
  runLineages = [],
  runLineagesNextCursor = null,
  knowledgeProposals = [],
}: Props) {
  const base = `/admin/clients/${tenantId}/venues/${venueId}/support-operations`
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Support operations
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-pf-deep">Client request workspace</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Review request history and add a bounded client-visible message or internal note. Package
          lifecycle controls are intentionally unavailable here; operators may record lineage to an
          existing draft.
        </p>
      </header>
      {requests.items.length === 0 ? (
        <Empty text="No support requests are recorded for this venue." />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
          <aside aria-label="Support requests">
            <div className="space-y-2">
              {requests.items.map((request) => (
                <Link
                  key={request.id}
                  href={`${base}?requestId=${encodeURIComponent(request.id)}`}
                  aria-current={selected?.id === request.id ? 'page' : undefined}
                  className={`block rounded-2xl border p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 ${selected?.id === request.id ? 'border-pf-primary bg-pf-surface' : 'border-pf-light bg-white'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-pf-primary">
                      {request.category.replace(/_/g, ' ')}
                    </span>
                    <span className="text-xs text-pf-deep/75">
                      {request.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p className="mt-2 font-semibold text-pf-deep">{request.subject}</p>
                  <p className="mt-1 text-xs text-pf-deep/75">
                    Updated {request.updatedAt.toLocaleString()}
                  </p>
                </Link>
              ))}
            </div>
            {requests.nextCursor ? (
              <PageLink
                href={query(base, null, 'requestCursor', requests.nextCursor)}
                label="Older requests"
              />
            ) : null}
          </aside>
          {selected ? (
            <div className="min-w-0 space-y-6">
              <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-800">
                    {selected.status.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-pf-deep/75">Version {selected.version}</span>
                </div>
                <h3 className="mt-3 text-xl font-semibold text-pf-deep">{selected.subject}</h3>
                <p className="mt-2 text-sm text-pf-deep/75">
                  Created by {selected.createdByKind.toLowerCase()} · last updated by{' '}
                  {selected.updatedByKind.toLowerCase()} · {selected.updatedAt.toLocaleString()}
                </p>
              </section>
              {selected.status === 'DRAFT' ? (
                <div className="space-y-6">
                  <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950 shadow-sm">
                    This machine-prepared draft is internal only. Review it, then explicitly open or
                    cancel it. Customer messaging, participant access, package work, and venue
                    changes remain unavailable while it is a draft.
                  </section>
                  <SupportStatusTransitionForm
                    tenantId={tenantId}
                    venueId={venueId}
                    requestId={selected.id}
                    currentStatus={selected.status}
                    expectedVersion={selected.version}
                  />
                </div>
              ) : selected.status === 'COMPLETED' || selected.status === 'CANCELLED' ? (
                <section className="rounded-3xl border border-pf-light bg-white p-5 text-sm text-pf-deep/75 shadow-sm">
                  This request is closed. New messages, notes, and files cannot be added.
                </section>
              ) : (
                <SupportVersionBoundActions
                  key={`${tenantId}:${venueId}:${selected.id}:${selected.version}:version-actions`}
                  tenantId={tenantId}
                  venueId={venueId}
                  requestId={selected.id}
                  expectedVersion={selected.version}
                  currentStatus={selected.status}
                  missingInformation={selected.missingInformation}
                >
                  <SupportMessageComposer
                    key={`${selected.id}:composer`}
                    tenantId={tenantId}
                    venueId={venueId}
                    requestId={selected.id}
                    expectedVersion={selected.version}
                    initialEligibleAttachments={eligibleAttachments}
                    initialEligibleAttachmentsNextCursor={eligibleAttachmentsNextCursor}
                  />
                  <SupportTriageForm
                    tenantId={tenantId}
                    venueId={venueId}
                    requestId={selected.id}
                    expectedVersion={selected.version}
                    initialCategory={selected.category}
                    initialMissingInformation={selected.missingInformation}
                    closed={false}
                  />
                  <SupportStatusTransitionForm
                    tenantId={tenantId}
                    venueId={venueId}
                    requestId={selected.id}
                    currentStatus={selected.status}
                    expectedVersion={selected.version}
                  />
                  <SupportPackageHandoffForm
                    tenantId={tenantId}
                    venueId={venueId}
                    requestId={selected.id}
                    expectedVersion={selected.version}
                    packages={draftPackages}
                    closed={false}
                  />
                  <ReviewedVenuePackageDraftForm
                    tenantId={tenantId}
                    venueId={venueId}
                    support={{ requestId: selected.id, expectedVersion: selected.version }}
                  />
                  <SupportKnowledgeProposalForm
                    tenantId={tenantId}
                    venueId={venueId}
                    requestId={selected.id}
                    expectedVersion={selected.version}
                    eligible={
                      selected.category === 'CONTENT_CORRECTION' &&
                      [
                        'IN_REVIEW',
                        'PATCH_DRAFTED',
                        'VALIDATING',
                        'AWAITING_APPROVAL',
                        'APPLYING',
                      ].includes(selected.status)
                    }
                    messages={messages.items}
                  />
                </SupportVersionBoundActions>
              )}
              <section className="space-y-3" aria-labelledby="support-handoffs-heading">
                <h3 id="support-handoffs-heading" className="text-xl font-semibold text-pf-deep">
                  Package lineage
                </h3>
                {handoffs.length === 0 ? (
                  <Empty text="No draft package is linked to this request." />
                ) : (
                  <ol className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-white px-4">
                    {handoffs.map((handoff) => (
                      <li key={handoff.id} className="py-3">
                        <p className="text-sm font-semibold text-pf-deep">
                          {handoff.venuePackageId}
                        </p>
                        <p className="mt-1 text-xs text-pf-deep/75">
                          Linked at request version {handoff.requestVersion} · current package
                          status {handoff.venuePackage.status} · schema v
                          {handoff.venuePackage.schemaVersion}
                        </p>
                        {handoff.supersessionAsPrior ? (
                          <p className="mt-1 text-xs font-semibold text-amber-800">
                            Historical fulfillment · replaced by handoff{' '}
                            {handoff.supersessionAsPrior.replacementHandoffId} at request version{' '}
                            {handoff.supersessionAsPrior.requestVersion}
                          </p>
                        ) : (
                          <p className="mt-1 text-xs font-semibold text-emerald-800">
                            Current fulfillment
                            {handoff.supersessionsAsReplacement.length > 0
                              ? ` · replaces ${handoff.supersessionsAsReplacement.length} historical handoff${handoff.supersessionsAsReplacement.length === 1 ? '' : 's'}`
                              : ''}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <SupportAgentRunLineagePanel
                key={`${tenantId}:${venueId}:${selected.id}:${selected.version}:run-lineage`}
                tenantId={tenantId}
                venueId={venueId}
                requestId={selected.id}
                expectedVersion={selected.version}
                lineages={runLineages}
                nextCursor={runLineagesNextCursor}
              />
              <section className="space-y-3" aria-labelledby="support-knowledge-heading">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 id="support-knowledge-heading" className="text-xl font-semibold text-pf-deep">
                    Knowledge proposal lineage
                  </h3>
                  <Link
                    href={`/admin/clients/${tenantId}/venues/${venueId}/knowledge-proposals`}
                    className="inline-flex min-h-11 items-center rounded-xl border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary"
                  >
                    Open review queue
                  </Link>
                </div>
                {knowledgeProposals.length === 0 ? (
                  <Empty text="No knowledge proposal is bound to a frozen version of this request." />
                ) : (
                  <ol className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-white px-4">
                    {knowledgeProposals.map((proposal) => (
                      <li key={proposal.id} className="py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-pf-deep">
                            Request version {proposal.supportRequestVersion} ·{' '}
                            {proposal.status.replaceAll('_', ' ')}
                          </p>
                          <span className="text-xs font-bold uppercase tracking-wide text-pf-primary">
                            {proposal.createdByType} prepared
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-pf-deep/75">
                          {proposal.proposedChange}
                        </p>
                        <p className="mt-1 text-xs text-pf-deep/65">
                          {Array.isArray(proposal.evidenceMessageIds)
                            ? proposal.evidenceMessageIds.length
                            : 0}{' '}
                          exact message reference
                          {Array.isArray(proposal.evidenceMessageIds) &&
                          proposal.evidenceMessageIds.length === 1
                            ? ''
                            : 's'}{' '}
                          retained · {proposal.createdAt.toLocaleString()}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <section className="space-y-3" aria-labelledby="support-thread-heading">
                <h3 id="support-thread-heading" className="text-xl font-semibold text-pf-deep">
                  Thread
                </h3>
                {messages.items.length === 0 ? (
                  <Empty text="No messages are recorded for this request." />
                ) : (
                  messages.items.map((message) => (
                    <article
                      key={message.id}
                      className={`rounded-2xl border p-4 ${message.visibility === 'INTERNAL_ONLY' ? 'border-amber-200 bg-amber-50' : 'border-sky-200 bg-sky-50'}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-bold ${message.visibility === 'INTERNAL_ONLY' ? 'bg-amber-200 text-amber-950' : 'bg-sky-200 text-sky-950'}`}
                        >
                          {message.visibility === 'INTERNAL_ONLY'
                            ? 'INTERNAL ONLY'
                            : 'CLIENT VISIBLE'}
                        </span>
                        <span className="text-xs text-pf-deep/75">
                          {message.authorKind} · {message.createdAt.toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-pf-deep">
                        {message.body}
                      </p>
                      {message.attachments.length ? (
                        <ul className="mt-3 space-y-1 text-xs text-pf-deep/75">
                          {message.attachments.map((attachment) => (
                            <li key={attachment.id}>
                              {attachment.filename} · {attachment.mediaType} · {attachment.byteSize}{' '}
                              bytes
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </article>
                  ))
                )}
                {messages.nextCursor ? (
                  <PageLink
                    href={query(base, selected.id, 'messageCursor', messages.nextCursor)}
                    label="Later messages"
                  />
                ) : null}
              </section>
              <section className="space-y-3" aria-labelledby="support-audit-heading">
                <h3 id="support-audit-heading" className="text-xl font-semibold text-pf-deep">
                  Audit evidence
                </h3>
                {audit.items.length === 0 ? (
                  <Empty text="No audit events are recorded for this request." />
                ) : (
                  <ol className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-white px-4">
                    {audit.items.map((event) => (
                      <li key={event.id} className="py-3">
                        <p className="text-sm font-semibold text-pf-deep">
                          {event.eventType.replace(/_/g, ' ')}
                        </p>
                        <p className="mt-1 text-xs text-pf-deep/75">
                          Version {event.requestVersion} · {event.actorKind} ·{' '}
                          {event.createdAt.toLocaleString()}
                          {event.fromStatus || event.toStatus
                            ? ` · ${event.fromStatus ?? '—'} → ${event.toStatus ?? '—'}`
                            : ''}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
                {audit.nextCursor ? (
                  <PageLink
                    href={query(base, selected.id, 'auditCursor', audit.nextCursor)}
                    label="Older audit evidence"
                  />
                ) : null}
              </section>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-pf-light bg-white p-8 text-center text-sm text-pf-deep/75">
      {text}
    </div>
  )
}
function PageLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="mt-3 flex justify-end">
      <Link
        href={href}
        className="inline-flex min-h-11 items-center rounded-xl border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
      >
        {label}
      </Link>
    </div>
  )
}
