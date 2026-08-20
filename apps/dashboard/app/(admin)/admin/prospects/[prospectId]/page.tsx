import Link from 'next/link'
import {
  ArrowLeft,
  Building2,
  ExternalLink,
  Mail,
  MapPin,
  MessageSquareText,
  Phone,
  Sparkles,
  UserRound,
} from 'lucide-react'

import { ProspectActionsPanel } from '../../../../../components/admin/ProspectActionsPanel'
import { createAdminCaller } from '../../../../../lib/admin-caller'

export const dynamic = 'force-dynamic'

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export default async function ProspectDetailPage({
  params,
}: {
  params: Promise<{ prospectId: string }>
}) {
  const { prospectId } = await params
  const caller = await createAdminCaller()
  const [prospect, intelligence] = await Promise.all([
    caller.admin.getProspect({ organizationId: prospectId }),
    caller.admin.getProspectIntelligence({ organizationId: prospectId }),
  ])
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
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div>
          <Link
            href="/admin/prospects"
            className="inline-flex items-center gap-2 text-sm font-semibold text-sky-700 hover:text-sky-900"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Prospect directory
          </Link>
          <div className="mt-4 flex items-start gap-3">
            <span className="rounded-xl bg-sky-100 p-3 text-sky-700">
              <Building2 className="h-6 w-6" aria-hidden="true" />
            </span>
            <div>
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
        {prospect.conversion ? (
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
        )}
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
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{term}</p>
            <p className="mt-2 text-lg font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,.8fr)]">
        <div className="space-y-6">
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
                    {venue.website ? (
                      <a
                        href={venue.website}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-sky-700"
                      >
                        Website <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
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
            {!prospect.contacts.length ? (
              <p className="mt-4 text-sm text-slate-500">No contacts researched yet.</p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-100">
                {prospect.contacts.map((contact) => (
                  <li key={contact.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex gap-3">
                        <UserRound className="mt-0.5 h-4 w-4 text-slate-400" />
                        <div>
                          <p className="font-semibold text-slate-900">
                            {contact.fullName ?? 'General contact'}
                          </p>
                          <p className="text-xs text-slate-500">
                            {contact.title ?? 'Role not confirmed'}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                            {contact.email ? (
                              <span className="inline-flex items-center gap-1">
                                <Mail className="h-3 w-3" />
                                {contact.email}
                              </span>
                            ) : null}
                            {contact.phone ? (
                              <span className="inline-flex items-center gap-1">
                                <Phone className="h-3 w-3" />
                                {contact.phone}
                              </span>
                            ) : null}
                          </div>
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

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <MessageSquareText className="h-5 w-5 text-sky-700" aria-hidden="true" />
              <h2 className="font-semibold text-slate-950">Correspondence history</h2>
            </div>
            {!prospect.emailThreads.length ? (
              <p className="mt-4 text-sm text-slate-500">No email correspondence recorded yet.</p>
            ) : (
              <div className="mt-4 space-y-4">
                {prospect.emailThreads.map((thread) => (
                  <article key={thread.id} className="rounded-xl border border-slate-200">
                    <div className="border-b border-slate-100 px-4 py-3">
                      <p className="text-sm font-semibold text-slate-900">
                        {thread.subject ?? 'Email thread'}
                      </p>
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        {thread.messages.length} message{thread.messages.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <ol className="divide-y divide-slate-100">
                      {thread.messages.map((message) => (
                        <li key={message.id} className="p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span
                              className={`rounded-full px-2 py-1 text-[10px] font-bold ${message.direction === 'INBOUND' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}
                            >
                              {message.direction} · {message.status}
                            </span>
                            <time className="text-xs text-slate-400">
                              {new Date(message.occurredAt).toLocaleString()}
                            </time>
                          </div>
                          <p className="mt-2 text-xs font-semibold text-slate-700">
                            {message.direction === 'INBOUND'
                              ? message.fromAddress
                              : `To ${message.toAddresses.join(', ')}`}
                          </p>
                          <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-600">
                            {message.textBody ?? 'HTML-only message'}
                          </p>
                        </li>
                      ))}
                    </ol>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside>
          <ProspectActionsPanel
            organizationId={prospect.id}
            currentStage={opportunity?.stage ?? 'DISCOVERED'}
            currentPriority={opportunity?.priority ?? prospect.priority}
            currentNextAction={opportunity?.nextAction ?? null}
            currentNextActionAt={opportunity?.nextActionAt?.toISOString() ?? null}
            archived={Boolean(prospect.archivedAt)}
          />
        </aside>
      </div>
    </div>
  )
}
