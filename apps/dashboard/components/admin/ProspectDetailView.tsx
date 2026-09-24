import Link from 'next/link'
import {
  ArrowLeft,
  Building2,
  Clock3,
  Database,
  ExternalLink,
  Mail,
  MapPin,
  Phone,
  Sparkles,
  UserRound,
} from 'lucide-react'

import { ProspectActionsPanel } from './ProspectActionsPanel'
import { ProspectContactabilityReview } from './ProspectContactabilityReview'
import { ProspectCorrespondenceHistory } from './ProspectCorrespondenceHistory'
import { ProspectMeetingHistory } from './ProspectMeetingHistory'
import { ProspectSalesPreparation } from './ProspectSalesReviewPanel'
import { ProspectDirectoryNeighbors } from './ProspectDirectoryNeighbors'
import type { createAdminCaller } from '../../lib/admin-caller'
import {
  capturedWorkbookLocation,
  recordedWorkbookLocation,
  recordedHttpUrl,
  prospectDirectoryReturnHref,
  recordedContactRole,
  recordedResearchDate,
} from '../../lib/prospect-source-display'

type AdminCaller = Awaited<ReturnType<typeof createAdminCaller>>
type Prospect = Awaited<ReturnType<AdminCaller['admin']['getProspect']>>
type Intelligence = Awaited<ReturnType<AdminCaller['admin']['getProspectIntelligence']>>

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

function recordedAt(value: Date | string | null | undefined) {
  return value ? new Date(value).toLocaleString() : 'Date not recorded'
}

export function ProspectDetailView({
  prospect,
  intelligence,
  readOnly = false,
  directoryHref = '/admin/prospects',
  directoryQuery,
  salesPreparationMode,
}: {
  prospect: Prospect
  intelligence: Intelligence
  readOnly?: boolean
  directoryHref?: string
  directoryQuery?: string | undefined
  salesPreparationMode?: 'local' | 'admin' | undefined
}) {
  const opportunity = prospect.opportunity
  const primaryVenue = prospect.venues.find((venue) => !venue.archivedAt) ?? prospect.venues[0]
  const conversionQuery = new URLSearchParams({
    prospectId: prospect.id,
    clientName: prospect.canonicalName,
    ...(primaryVenue ? { venueName: primaryVenue.name } : {}),
    ...(primaryVenue ? { prospectVenueId: primaryVenue.id } : {}),
    ...(prospect.contacts.find((contact) => contact.email)?.email
      ? { primaryContactEmail: prospect.contacts.find((contact) => contact.email)!.email! }
      : {}),
  })

  return (
    <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <Link
            href={prospectDirectoryReturnHref(directoryHref, directoryQuery)}
            className="inline-flex items-center gap-2 text-sm font-semibold text-sky-700 hover:text-sky-900"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Prospect directory
          </Link>
          <ProspectDirectoryNeighbors
            base={directoryHref}
            query={directoryQuery ?? ''}
            prospectId={prospect.id}
          />
          <div className="mt-4 flex items-start gap-3">
            <span className="rounded-xl bg-sky-100 p-3 text-sky-700">
              <Building2 className="h-6 w-6" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-bold tracking-tight text-slate-950">
                  {prospect.canonicalName}
                </h1>
                {prospect.archivedAt ? (
                  <span className="rounded-full bg-slate-200 px-2 py-1 text-xs font-bold text-slate-700">
                    Archived
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {prospect.organizationType ?? 'Prospect organization'} ·{' '}
                {prospect.territory?.name ?? 'Unassigned territory'}
              </p>
            </div>
          </div>
        </div>
        {!readOnly ? (
          prospect.conversion ? (
            <Link
              href={`/admin/clients/${prospect.conversion.tenant.id}`}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
            >
              Open customer <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </Link>
          ) : (
            <Link
              href={`/admin/new?${conversionQuery.toString()}`}
              className="rounded-xl bg-sky-600 px-4 py-2.5 text-center text-sm font-semibold text-white"
            >
              Convert to customer
            </Link>
          )
        ) : null}
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ['Stage', label(opportunity?.stage ?? 'DISCOVERED')],
          ['Priority', opportunity?.priority ?? prospect.priority],
          ['Venues', String(prospect.venues.length)],
          ['Contacts', String(prospect.contacts.length)],
          ['Relationship tier', label(prospect.relationshipTier)],
        ].map(([term, value]) => (
          <div key={term} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-600">{term}</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </section>

      {primaryVenue &&
      (salesPreparationMode ||
        (!readOnly && process.env.TORCHIKO_LOCAL_CRM_SALES_ENABLED === '1')) ? (
        <ProspectSalesPreparation
          venueId={primaryVenue.id}
          mode={salesPreparationMode ?? 'admin'}
        />
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,.8fr)]">
        <div className="min-w-0 space-y-6">
          {prospect.summaries[0] ? (
            <section className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-slate-950">Current relationship summary</h2>
                <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold uppercase text-indigo-800">
                  AI summary · {prospect.summaries[0].status.toLowerCase()}
                </span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                {prospect.summaries[0].summary}
              </p>
              <p className="mt-3 text-xs text-slate-500">
                Version {prospect.summaries[0].version} · updated{' '}
                {new Date(prospect.summaries[0].updatedAt).toLocaleString()}
              </p>
            </section>
          ) : null}

          {prospect.openLoops.length || prospect.commitments.length ? (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
              <h2 className="font-semibold text-slate-950">Open loops and commitments</h2>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-amber-800">
                    Waiting
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {prospect.openLoops.map((loop) => (
                      <li
                        key={loop.id}
                        className="rounded-xl border border-amber-200 bg-white p-3 text-sm"
                      >
                        <p className="font-semibold text-slate-900">{loop.title}</p>
                        <p className="mt-1 text-xs text-slate-600">
                          Waiting on {label(loop.waitingOn)}
                          {loop.dueAt ? ` · due ${new Date(loop.dueAt).toLocaleDateString()}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-amber-800">
                    Promises
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {prospect.commitments.map((commitment) => (
                      <li
                        key={commitment.id}
                        className="rounded-xl border border-amber-200 bg-white p-3 text-sm"
                      >
                        <p className="font-semibold text-slate-900">{commitment.statement}</p>
                        <p className="mt-1 text-xs text-slate-600">
                          {label(commitment.party)}
                          {commitment.dueAt
                            ? ` · due ${new Date(commitment.dueAt).toLocaleDateString()}`
                            : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ) : null}

          {prospect.relationshipNotes.length ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-slate-950">Relationship knowledge</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {prospect.relationshipNotes.map((note) => (
                  <article key={note.id} className="rounded-xl border border-slate-200 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-sky-700">
                      {label(note.category)} · {label(note.authority)}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{note.body}</p>
                    <p className="mt-2 text-xs text-slate-400">
                      Source: {label(note.sourceType)}
                      {note.lastConfirmedAt
                        ? ` · confirmed ${new Date(note.lastConfirmedAt).toLocaleDateString()}`
                        : ''}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section className="border-y border-slate-200 bg-white px-5 py-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Database className="h-5 w-5 text-sky-700" aria-hidden="true" />
                  <h2 className="font-semibold text-slate-950">
                    Research evidence and import history
                  </h2>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                  These records show what was captured and where it came from. A recorded email,
                  website, or source is not an outreach permission or a fit assessment.
                </p>
              </div>
              <span className="text-xs font-medium text-slate-500">
                {prospect.sources.length} source{prospect.sources.length === 1 ? '' : 's'} recorded
              </span>
            </div>

            {prospect.sources.length ? (
              <ol className="mt-5 divide-y divide-slate-100 border-y border-slate-100">
                {prospect.sources.map((source) => (
                  <li key={source.id} className="py-4 first:pt-4 last:pb-4">
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-800">
                          {label(source.sourceType)}
                        </p>
                        <p className="mt-1 break-words text-sm font-semibold text-slate-900">
                          {source.sourceLabel ?? 'Source label not recorded'}
                        </p>
                        {recordedHttpUrl(source.sourceUrl) ? (
                          <a
                            href={recordedHttpUrl(source.sourceUrl)!}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-xs font-semibold text-sky-700 hover:underline"
                          >
                            Open recorded source{' '}
                            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                          </a>
                        ) : (
                          <p className="mt-1 text-xs text-slate-500">
                            {source.sourceUrl
                              ? 'Recorded source URL cannot be opened safely'
                              : 'Source URL not recorded'}
                          </p>
                        )}
                        {source.capturedValue ? (
                          <details className="mt-3 min-w-0 max-w-full text-xs leading-5 text-slate-700">
                            <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                              View original captured source fields
                            </summary>
                            <pre
                              tabIndex={0}
                              role="region"
                              aria-label="Original captured source fields"
                              className="max-h-96 max-w-full overflow-y-auto whitespace-pre-wrap break-all border border-slate-200 bg-slate-50 p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700"
                            >
                              {typeof source.capturedValue === 'string'
                                ? source.capturedValue
                                : JSON.stringify(source.capturedValue, null, 2)}
                            </pre>
                          </details>
                        ) : null}
                      </div>
                      <dl className="min-w-0 space-y-1 break-words text-xs text-slate-600 sm:max-w-[50%] sm:text-right">
                        <div>
                          <dt className="sr-only">Researched</dt>
                          <dd>
                            Researched:{' '}
                            {recordedResearchDate(source.capturedValue, source.researchedAt)}
                          </dd>
                        </div>
                        {source.importRow ? (
                          <>
                            <div>
                              <dt className="sr-only">Imported from</dt>
                              <dd>
                                Imported from {source.importRow.import.fileName} · sheet{' '}
                                {source.importRow.sheetName}, row{' '}
                                {source.importRow.originalRowNumber}
                              </dd>
                            </div>
                            <div>
                              <dt className="sr-only">Import status</dt>
                              <dd>
                                {label(source.importRow.import.status)} ·{' '}
                                {recordedAt(source.importRow.import.createdAt)}
                              </dd>
                            </div>
                          </>
                        ) : capturedWorkbookLocation(source.capturedValue) ? (
                          <div>
                            <dt className="sr-only">Native workbook lineage</dt>
                            <dd>
                              Workbook sheet{' '}
                              {capturedWorkbookLocation(source.capturedValue)!.sheetName}, row{' '}
                              {capturedWorkbookLocation(source.capturedValue)!.originalRowNumber}
                            </dd>
                            <dd className="mt-1 break-all">
                              Raw-row SHA-256:{' '}
                              {capturedWorkbookLocation(source.capturedValue)!.rawRowSha256 ??
                                'Not recorded'}
                            </dd>
                          </div>
                        ) : (
                          <div>
                            <dt className="sr-only">Import lineage</dt>
                            <dd>Import lineage not recorded</dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-5 border border-dashed border-slate-300 px-4 py-5 text-sm text-slate-500">
                No source evidence has been recorded for this organization.
              </p>
            )}

            <div className="mt-6">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-slate-500" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-900">Canonical import history</h3>
              </div>
              {prospect.importHistory.length ? (
                <ul className="mt-3 grid gap-3 md:grid-cols-2">
                  {prospect.importHistory.map((entry) => (
                    <li key={entry.id} className="border border-slate-200 bg-slate-50 p-4">
                      <p className="break-words text-sm font-semibold text-slate-900">
                        {entry.import.fileName}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        {label(entry.recordKind)} · {label(entry.processingStatus)}
                      </p>
                      {recordedWorkbookLocation(entry.rawPayload) ? (
                        <p className="mt-2 text-xs text-slate-600">
                          Sheet {recordedWorkbookLocation(entry.rawPayload)!.sheetName}, row{' '}
                          {recordedWorkbookLocation(entry.rawPayload)!.originalRowNumber}
                        </p>
                      ) : null}
                      <p className="mt-2 break-all text-[11px] text-slate-500">
                        Workbook hash: {entry.sourceWorkbookHash}
                      </p>
                      <p className="mt-1 break-all text-[11px] text-slate-600">
                        Package hash: {entry.import.packageHash ?? 'Not recorded'}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Processed {recordedAt(entry.processedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-slate-500">
                  No canonical import history is recorded.
                </p>
              )}
            </div>
          </section>

          <ProspectMeetingHistory meetings={prospect.companyMeetings} />

          {prospect.companyKnowledgeItems.length ? (
            <section className="rounded-2xl border border-violet-200 bg-violet-50 p-5 shadow-sm">
              <h2 className="font-semibold text-slate-950">Company knowledge</h2>
              <div className="mt-4 space-y-3">
                {prospect.companyKnowledgeItems.map((item) => (
                  <article
                    key={item.id}
                    className="rounded-xl border border-violet-200 bg-white p-4"
                  >
                    <p className="text-[10px] font-bold uppercase tracking-wider text-violet-700">
                      {label(item.type)} · {label(item.authority)}
                    </p>
                    <h3 className="mt-1 font-semibold text-slate-900">{item.title}</h3>
                    <p className="mt-2 text-sm text-slate-600">{item.summary}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-950">Venue intelligence</h2>
            {!prospect.venues.length ? (
              <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
                No prospect venues linked yet.
              </p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {prospect.venues.map((venue) => (
                  <article key={venue.id} className="rounded-xl border border-slate-200 p-4">
                    {prospect.territory?.name === 'Chicago Metro' && !readOnly && (
                      <Link
                        href={`${directoryHref}?scope=chicago&venue=${encodeURIComponent(venue.id)}`}
                        className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-sky-800 underline underline-offset-4"
                      >
                        Chicago ranking & source evidence →
                      </Link>
                    )}
                    <div className="flex items-start gap-2">
                      <MapPin className="mt-0.5 h-4 w-4 text-sky-700" aria-hidden="true" />
                      <div>
                        <h3 className="font-semibold text-slate-900">{venue.name}</h3>
                        <p className="mt-1 text-xs text-slate-500">
                          {[venue.city, venue.region].filter(Boolean).join(', ') ||
                            'Location not researched'}{' '}
                          · {venue.venueType ?? 'Uncategorized'}
                        </p>
                      </div>
                    </div>
                    {recordedHttpUrl(venue.website) ? (
                      <a
                        href={recordedHttpUrl(venue.website)!}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-sky-700"
                      >
                        Website <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <p className="mt-3 text-xs text-slate-500">
                        {venue.website
                          ? 'Website text recorded; safe URL not established'
                          : 'Website not recorded'}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-700" aria-hidden="true" />
              <h2 className="font-semibold text-slate-950">Unified Torchiko intelligence</h2>
            </div>
            {!intelligence.liveVenue ? (
              <p className="mt-3 text-sm leading-6 text-slate-600">
                This prospect is not linked to a live Torchiko venue yet. Its research and
                correspondence remain available here and will stay linked after conversion.
              </p>
            ) : (
              <div className="mt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-slate-950">{intelligence.liveVenue.name}</p>
                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-bold text-emerald-800">
                    LIVE CUSTOMER DATA
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {intelligence.liveVenue.places.length} active places/exhibits ·{' '}
                  {intelligence.liveVenue.knowledge.length} knowledge entries
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {intelligence.liveVenue.places.slice(0, 8).map((place) => (
                    <article
                      key={place.id}
                      className="rounded-xl border border-violet-100 bg-white p-3"
                    >
                      <p className="text-sm font-semibold text-slate-900">{place.name}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                        {place.shortDescription ?? place.type}
                      </p>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-950">Contacts and suppression</h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Contact data is research evidence. It does not by itself authorize outreach.
            </p>
            {!prospect.contacts.length ? (
              <p className="mt-4 text-sm text-slate-600">
                No contact recorded. Contact details and permission remain unknown.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-100">
                {prospect.contacts.map((contact) => (
                  <li key={contact.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 gap-3">
                        <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900">
                            {contact.fullName ?? 'Name not recorded'}
                          </p>
                          <p className="mt-1 text-xs text-slate-600">
                            {recordedContactRole(contact.provenance)}
                          </p>
                          <p className="text-xs text-slate-500">
                            {contact.title ?? 'Role not confirmed'}
                          </p>
                          <p className="text-xs text-slate-500">
                            {contact.venueId
                              ? `Associated venue: ${prospect.venues.find((venue) => venue.id === contact.venueId)?.name ?? 'Venue record unavailable'}`
                              : 'Organization contact · venue association not recorded'}
                            {contact.archivedAt ? ' · archived contact' : ''}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Email status: {label(contact.emailReadiness)} · permission:{' '}
                            {label(contact.permissionState)}
                          </p>
                          {contact.suppressionReason ? (
                            <p className="mt-1 text-xs font-medium text-rose-800">
                              Hold reason: {contact.suppressionReason}
                            </p>
                          ) : null}
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                            {contact.email ? (
                              <span className="inline-flex min-w-0 break-all items-center gap-1">
                                <Mail className="h-3 w-3 shrink-0" />
                                {contact.email}
                              </span>
                            ) : (
                              <span>Email not recorded</span>
                            )}
                            {contact.phone ? (
                              <span className="inline-flex items-center gap-1">
                                <Phone className="h-3 w-3" />
                                {contact.phone}
                              </span>
                            ) : null}
                          </div>
                          {contact.email && !contact.archivedAt && !readOnly ? (
                            <ProspectContactabilityReview
                              contactId={contact.id}
                              emailReadiness={contact.emailReadiness}
                              permissionState={contact.permissionState}
                              disabledReason={
                                contact.doNotContact ||
                                Boolean(contact.suppressedAt) ||
                                Boolean(contact.unsubscribedAt) ||
                                contact.permissionState === 'OPTED_OUT' ||
                                contact.permissionState === 'PROHIBITED'
                                  ? 'This contact is suppressed. Use the separately audited restoration workflow before any readiness review.'
                                  : undefined
                              }
                            />
                          ) : null}
                        </div>
                      </div>
                      {contact.doNotContact ? (
                        <span className="rounded-full bg-rose-100 px-2 py-1 text-[10px] font-bold uppercase text-rose-800">
                          Do not contact
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-950">Durable activity timeline</h2>
            {!prospect.activities.length ? (
              <p className="mt-4 text-sm text-slate-500">No activity recorded.</p>
            ) : (
              <ol className="mt-4 space-y-4 border-l border-slate-200 pl-5">
                {prospect.activities.map((activity) => (
                  <li key={activity.id} className="relative">
                    <span className="absolute -left-[1.48rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-sky-500 ring-1 ring-slate-200" />
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold text-slate-900">{activity.summary}</h3>
                      <time className="text-xs text-slate-400">
                        {new Date(activity.occurredAt).toLocaleString()}
                      </time>
                    </div>
                    {activity.detail ? (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
                        {activity.detail}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      {label(activity.type)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <ProspectCorrespondenceHistory
            threads={prospect.emailThreads}
            totalThreadCount={prospect._count.emailThreads}
            enableRetentionActions={!readOnly}
            enableReplyReviewActions={!readOnly}
          />
        </div>

        <aside className="min-w-0">
          {intelligence.billing ? (
            <section className="mb-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
                Customer billing
              </p>
              <h2 className="mt-2 text-lg font-semibold text-slate-950">
                {label(intelligence.billing.status)}
              </h2>
              {(() => {
                const agreement =
                  intelligence.billing.commercialAgreements.find((item) => item.isBase) ??
                  intelligence.billing.commercialAgreements[0]
                return agreement?.agreedAmountMinor !== null && agreement ? (
                  <p className="mt-2 text-2xl font-bold text-slate-950">
                    {new Intl.NumberFormat('en-US', {
                      style: 'currency',
                      currency: agreement.currency.toUpperCase(),
                    }).format(Number(agreement.agreedAmountMinor) / 100)}
                    <span className="ml-1 text-sm font-medium text-slate-600">
                      per {agreement.billingInterval.toLowerCase()}
                    </span>
                  </p>
                ) : null
              })()}
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">Paid through</dt>
                  <dd className="font-semibold text-slate-900">
                    {intelligence.billing.paidThroughAt
                      ? new Date(intelligence.billing.paidThroughAt).toLocaleDateString()
                      : 'Not recorded'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">Reconciliation</dt>
                  <dd className="font-semibold text-slate-900">
                    {label(intelligence.billing.reconciliationHealth)}
                  </dd>
                </div>
              </dl>
              <Link
                href={`/admin/clients/${intelligence.billing.tenantId}/billing`}
                className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-800 hover:underline"
              >
                Open billing record <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </Link>
            </section>
          ) : null}
          {!readOnly ? (
            <ProspectActionsPanel
              organizationId={prospect.id}
              currentStage={opportunity?.stage ?? 'DISCOVERED'}
              currentPriority={opportunity?.priority ?? prospect.priority}
              currentNextAction={opportunity?.nextAction ?? null}
              currentNextActionAt={opportunity?.nextActionAt?.toISOString() ?? null}
              archived={Boolean(prospect.archivedAt)}
            />
          ) : (
            <p className="border-y border-slate-200 py-4 text-sm leading-6 text-slate-600">
              {salesPreparationMode === 'local'
                ? 'Source records remain read-only. The separate local sales panel can prepare, save revisions and record review; no consent change, approval or delivery is authorized.'
                : 'Local read-only acceptance view. Research, consent, approval, sending, and relationship changes are not authorized here.'}
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
