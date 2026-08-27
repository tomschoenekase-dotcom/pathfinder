'use client'

import { useEffect, useState } from 'react'

const views = ['directory', 'venues', 'analytics', 'transcript'] as const
type View = (typeof views)[number]

const clients = Array.from({ length: 100 }, (_, index) => ({
  id: `client-${index + 1}`,
  name: `Regional Visitor Group ${String(index + 1).padStart(3, '0')}`,
  venues: 8 + (index % 17),
  sessions: 940 + index * 23,
  status: index % 11 === 0 ? 'Needs attention' : 'Active',
}))

const venues = Array.from({ length: 60 }, (_, index) => ({
  id: `venue-${index + 1}`,
  name: `Visitor Experience ${String(index + 1).padStart(2, '0')}`,
  slug: `visitor-experience-${index + 1}`,
  items: 36 + index * 2,
  active: index % 13 !== 0,
}))

const sessions = Array.from({ length: 20 }, (_, index) => ({
  id: `session-${index + 1}`,
  venue: venues[index % venues.length]!.name,
  messages: 3 + (index % 14),
  visitor: `visitor_${String(index + 1).padStart(4, '0')}`,
}))

const messages = Array.from({ length: 50 }, (_, index) => ({
  id: `message-${index + 1}`,
  role: index % 2 === 0 ? 'Guest' : 'Torchiko',
  body:
    index % 2 === 0
      ? `Question ${index + 1}: Where can I find the nearest accessible entrance and what should I expect when I arrive?`
      : `Answer ${index + 1}: Use the east entrance beside the welcome desk. The route is step-free and staff can help with directions.`,
}))

function DirectoryView() {
  return (
    <section data-view="directory" className="space-y-4">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Operator directory
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          100 client accounts
        </h2>
      </header>
      <div className="overflow-hidden rounded-2xl border border-pf-light bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-pf-light bg-pf-surface/60 text-xs uppercase tracking-wider text-pf-deep/60">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Venues</th>
              <th className="px-4 py-3">Sessions</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.id} className="border-b border-pf-light/70 last:border-0">
                <td className="px-4 py-3 font-semibold text-pf-deep">{client.name}</td>
                <td className="px-4 py-3 text-pf-deep/70">{client.venues}</td>
                <td className="px-4 py-3 text-pf-deep/70">{client.sessions.toLocaleString()}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-pf-surface px-2.5 py-1 text-xs font-semibold text-pf-deep/70">
                    {client.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function VenuesView() {
  return (
    <section data-view="venues" className="space-y-4">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Client workspace
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          60 venue workspaces
        </h2>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {venues.map((venue) => (
          <article
            key={venue.id}
            className="rounded-2xl border border-pf-light bg-white p-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-semibold text-pf-deep">{venue.name}</h3>
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${venue.active ? 'bg-emerald-500' : 'bg-amber-500'}`}
              />
            </div>
            <p className="mt-2 font-mono text-xs text-pf-deep/55">{venue.slug}</p>
            <p className="mt-3 text-sm text-pf-deep/70">{venue.items} guide items</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function AnalyticsView() {
  return (
    <section data-view="analytics" className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Portfolio analytics
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          Recent conversations
        </h2>
        <p className="mt-2 text-sm text-pf-deep/60">
          Summaries stay bounded; message bodies load only in transcript review.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-3">
        {['12,480 sessions', '31,206 messages', '8,912 visitors'].map((value) => (
          <div
            key={value}
            className="rounded-2xl border border-pf-light bg-white p-5 text-xl font-semibold text-pf-deep"
          >
            {value}
          </div>
        ))}
      </div>
      <div className="space-y-3">
        {sessions.map((session) => (
          <article
            key={session.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-pf-light bg-white p-4"
          >
            <div>
              <h3 className="font-semibold text-pf-deep">{session.venue}</h3>
              <p className="mt-1 text-xs text-pf-deep/60">
                {session.messages} guest messages · {session.visitor}
              </p>
            </div>
            <span className="rounded-full border border-pf-light px-3 py-2 text-xs font-semibold text-pf-primary">
              Review transcript
            </span>
          </article>
        ))}
      </div>
    </section>
  )
}

function TranscriptView() {
  return (
    <section data-view="transcript" className="space-y-4">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Guest conversation
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
          50 of 2,400 messages
        </h2>
        <p className="mt-2 text-sm text-pf-deep/60">
          One bounded page from a deliberately long history.
        </p>
      </header>
      <div className="space-y-3 rounded-2xl border border-pf-light bg-white p-5">
        {messages.map((message) => (
          <article
            key={message.id}
            className={`max-w-3xl rounded-2xl p-4 text-sm leading-6 ${message.role === 'Guest' ? 'bg-pf-surface text-pf-deep' : 'ml-auto bg-pf-primary text-white'}`}
          >
            <p className="text-xs font-bold uppercase tracking-wider opacity-70">{message.role}</p>
            <p className="mt-1">{message.body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export function DashboardPerformanceFixture() {
  const [view, setView] = useState<View>('directory')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  return (
    <main
      data-performance-ready={hydrated ? '' : undefined}
      className="min-h-screen bg-pf-surface/30 px-5 py-8 text-pf-deep sm:px-8"
    >
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-3xl border border-pf-light bg-white p-6 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-pf-primary">
            Development-only pressure fixture
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Dashboard high-volume paths
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
            Deterministic client, venue, analytics, and transcript states. No database, provider, or
            customer data is read.
          </p>
        </header>
        <nav aria-label="Performance fixture views" className="flex flex-wrap gap-2">
          {views.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setView(item)}
              data-view-button={item}
              aria-pressed={view === item}
              className={`min-h-11 rounded-full px-4 text-sm font-semibold capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent ${view === item ? 'bg-pf-primary text-white' : 'border border-pf-light bg-white text-pf-deep'}`}
            >
              {item}
            </button>
          ))}
        </nav>
        {view === 'directory' ? (
          <DirectoryView />
        ) : view === 'venues' ? (
          <VenuesView />
        ) : view === 'analytics' ? (
          <AnalyticsView />
        ) : (
          <TranscriptView />
        )}
      </div>
    </main>
  )
}
