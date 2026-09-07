'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

type Attention = inferRouterOutputs<AppRouter>['admin']['attentionConsole']
type View = 'NOW' | 'LATER' | 'COMPLETED'

type Item = {
  id: string
  title: string
  detail: string
  label: string
  href: string
  venueId: string | null
  rank: number
}

export function deriveTwoMinuteItems(data: Attention) {
  const now: Item[] = []
  const later: Item[] = []

  for (const question of data.questions.items) {
    const item: Item = {
      id: `question:${question.id}`,
      title: question.question,
      detail: `${question.agentIdentity.name} · ${question.blocking ? 'work is waiting for this answer' : question.urgency === 'URGENT' ? 'urgent review requested' : 'advisory question'}`,
      label:
        question.urgency === 'URGENT'
          ? question.blocking
            ? 'Urgent answer required'
            : 'Urgent review'
          : question.blocking
            ? 'Answer required'
            : 'Can wait',
      href: '#needs-you-heading',
      venueId: question.venueId,
      rank:
        question.urgency === 'URGENT'
          ? question.blocking
            ? 92
            : 91
          : question.blocking
            ? 90
            : question.urgency === 'HIGH'
              ? 60
              : 20,
    }
    ;(question.blocking || question.urgency === 'URGENT' ? now : later).push(item)
  }

  for (const approval of data.approvals.items) {
    if (approval.expired) continue
    now.push({
      id: `approval:${approval.id}`,
      title: approval.proposedAction,
      detail: `${approval.agentIdentity.name} · explicit approval required`,
      label: 'Decision required',
      href: '#approval-attention-heading',
      venueId: approval.venueId,
      rank: approval.riskCategory === 'HIGH' ? 95 : approval.riskCategory === 'MEDIUM' ? 75 : 55,
    })
  }

  for (const event of data.events.items) {
    if (!event.actionRequired) continue
    now.push({
      id: `event:${event.id}`,
      title: event.title,
      detail: event.recommendedAction || event.summary,
      label: event.severity === 'CRITICAL' ? 'Critical risk' : 'Review risk',
      href: '#customer-alerts',
      venueId: event.venueId,
      rank: event.severity === 'CRITICAL' ? 100 : event.severity === 'ERROR' ? 85 : 50,
    })
  }

  for (const event of data.platformEvents.items) {
    if (!event.actionRequired) continue
    now.push({
      id: `event:${event.id}`,
      title: event.title,
      detail: event.recommendedAction || event.summary,
      label: event.severity === 'CRITICAL' ? 'Critical risk' : 'Review risk',
      href: '#alerts',
      venueId: null,
      rank: event.severity === 'CRITICAL' ? 100 : event.severity === 'ERROR' ? 85 : 50,
    })
  }

  for (const run of data.blockedAgents.items) {
    now.push({
      id: `run:${run.id}`,
      title: run.requestedOperation,
      detail: `${run.agentIdentity.name} · ${run.status.replaceAll('_', ' ').toLowerCase()}`,
      label: run.status === 'FAILED' ? 'Agent failed' : 'Agent blocked',
      href: '#agent-work-heading',
      venueId: run.venueId,
      rank: run.status === 'FAILED' ? 88 : 70,
    })
  }

  const completed: Item[] = data.completedAgents.items.map((run) => ({
    id: `completed:${run.id}`,
    title: run.requestedOperation,
    detail: `${run.agentIdentity.name} · ${run._count.outcomeObservations} recorded outcome ${run._count.outcomeObservations === 1 ? 'signal' : 'signals'}`,
    label: 'Completed',
    href: '#agent-work-heading',
    venueId: run.venueId,
    rank: 0,
  }))

  now.sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id))
  later.sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id))
  return { now, later, completed }
}

function hasMore(data: Attention) {
  return [
    data.questions,
    data.approvals,
    data.events,
    data.platformEvents,
    data.blockedAgents,
    data.completedAgents,
  ].some((page) => page.nextCursor !== null)
}

export function FounderTwoMinuteBoard({ data }: { data: Attention }) {
  const [view, setView] = useState<View>('NOW')
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => deriveTwoMinuteItems(data), [data])
  const items = view === 'NOW' ? groups.now : view === 'LATER' ? groups.later : groups.completed
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const filteredItems = normalizedFilter
    ? items.filter((item) =>
        [item.title, item.detail, item.label, item.venueId]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedFilter)),
      )
    : items
  const visible = filteredItems.slice(0, 6)
  const venueCount = new Set(filteredItems.map((item) => item.venueId).filter(Boolean)).size

  return (
    <section
      aria-labelledby="two-minute-board-heading"
      className="rounded-3xl border border-slate-300 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-800">
            Attention board
          </p>
          <h2 id="two-minute-board-heading" className="mt-1 text-xl font-semibold text-slate-950">
            What needs your attention
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Decisions, questions, and updates from your agents.
          </p>
        </div>
        <p className="text-xs text-slate-500">
          {venueCount} {venueCount === 1 ? 'venue' : 'venues'} represented in this view
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-sm font-semibold text-slate-800">
          Filter loaded items
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder="Venue ID, issue, agent, or status"
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 font-normal text-slate-950 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          />
        </label>
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter('')}
            className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Clear filter
          </button>
        ) : null}
      </div>

      <div
        className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1"
        role="tablist"
        aria-label="Attention views"
        onKeyDown={(event) => {
          const views: View[] = ['NOW', 'LATER', 'COMPLETED']
          const current = views.indexOf(view)
          const next =
            event.key === 'ArrowRight'
              ? (current + 1) % 3
              : event.key === 'ArrowLeft'
                ? (current + 2) % 3
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 2
                    : null
          if (next === null) return
          event.preventDefault()
          setView(views[next]!)
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}
      >
        {(
          [
            ['NOW', 'Needs action', groups.now.length],
            ['LATER', 'Can wait', groups.later.length],
            ['COMPLETED', 'Completed', groups.completed.length],
          ] as const
        ).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`attention-tab-${value}`}
            aria-controls="attention-summary-panel"
            aria-selected={view === value}
            tabIndex={view === value ? 0 : -1}
            onClick={() => setView(value)}
            className={`min-h-11 rounded-lg px-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              view === value
                ? 'bg-white text-slate-950 shadow-sm'
                : 'text-slate-600 hover:text-slate-950'
            }`}
          >
            <span className="block sm:inline">{label}</span>{' '}
            <span className="tabular-nums" aria-label={`${count} items`}>
              {count}
            </span>
          </button>
        ))}
      </div>

      <div role="tabpanel" id="attention-summary-panel" aria-labelledby={`attention-tab-${view}`}>
        {visible.length ? (
          <ol className="mt-4 grid gap-2 lg:grid-cols-2">
            {visible.map((item, index) => (
              <li key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-start gap-3">
                  <span
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">
                      {item.label}
                    </p>
                    <p className="mt-1 font-semibold leading-6 text-slate-950">{item.title}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{item.detail}</p>
                    <Link
                      href={item.href}
                      className="mt-2 inline-flex min-h-10 items-center text-sm font-semibold text-sky-800 underline decoration-sky-200 underline-offset-4"
                    >
                      Open details
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : normalizedFilter ? (
          <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
            No loaded items in this view match “{filter.trim()}”. Clear the filter or choose another
            view.
          </p>
        ) : (
          <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
            {view === 'NOW'
              ? 'Nothing in this summary needs your action right now.'
              : view === 'LATER'
                ? 'No lower-priority founder questions are loaded.'
                : 'No completed agent work is loaded.'}
          </p>
        )}
      </div>

      <p className="mt-3 text-xs leading-5 text-slate-500" role="status">
        Showing {visible.length} of {filteredItems.length} matching loaded items in this view
        {normalizedFilter ? ` (${items.length} loaded before filtering)` : ''}
        {filteredItems.length > visible.length
          ? '; refine the filter or open the linked queue'
          : ''}
        {hasMore(data) ? '; older records exist beyond this bounded snapshot' : ''}. Counts are not
        venue health scores.
      </p>
    </section>
  )
}
