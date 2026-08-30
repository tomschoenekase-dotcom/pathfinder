'use client'

import Link from 'next/link'
import React, { useMemo, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'
import { AgentQuestionAnswerForm } from './AgentQuestionAnswerForm'
import { AgentQuestionEvidence } from './AgentQuestionEvidence'

type Attention = inferRouterOutputs<AppRouter>['admin']['attentionConsole']
type Question = Attention['questions']['items'][number]

const urgencyRank = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 } as const

function label(value: string) {
  return value.replaceAll('_', ' ').replaceAll('-', ' ').replaceAll('.', ' / ')
}

function age(createdAt: Date | string, generatedAt: Date | string) {
  const elapsedMs = Math.max(0, new Date(generatedAt).getTime() - new Date(createdAt).getTime())
  const hours = Math.floor(elapsedMs / 3_600_000)
  if (hours < 1) return 'less than an hour old'
  if (hours < 24) return `${hours}h old`
  const days = Math.floor(hours / 24)
  return `${days}d old`
}

function createdTime(value: Date | string) {
  return new Date(value).toLocaleString()
}

function prioritySort(left: Question, right: Question) {
  if (left.blocking !== right.blocking) return left.blocking ? -1 : 1
  const urgency = urgencyRank[right.urgency] - urgencyRank[left.urgency]
  if (urgency !== 0) return urgency
  const created = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  return created || left.id.localeCompare(right.id)
}

export function FounderQuestionTriageBoard({
  questions,
  generatedAt,
}: {
  questions: Attention['questions']
  generatedAt: Attention['generatedAt']
}) {
  const [search, setSearch] = useState('')
  const [dependency, setDependency] = useState<'ALL' | 'BLOCKING' | 'LOCAL'>('ALL')
  const [urgency, setUrgency] = useState<'ALL' | Question['urgency']>('ALL')
  const [category, setCategory] = useState('ALL')
  const [sort, setSort] = useState<'PRIORITY' | 'NEWEST' | 'OLDEST'>('PRIORITY')

  const categories = useMemo(
    () => [...new Set(questions.items.map((question) => question.category))].sort(),
    [questions.items],
  )
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visible = useMemo(() => {
    const filtered = questions.items.filter((question) => {
      if (dependency === 'BLOCKING' && !question.blocking) return false
      if (dependency === 'LOCAL' && question.blocking) return false
      if (urgency !== 'ALL' && question.urgency !== urgency) return false
      if (category !== 'ALL' && question.category !== category) return false
      if (!normalizedSearch) return true
      return [
        question.question,
        question.context,
        question.category,
        question.agentIdentity.name,
        question.agentRun?.requestedOperation,
      ]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLocaleLowerCase().includes(normalizedSearch))
    })
    return [...filtered].sort((left, right) => {
      if (sort === 'PRIORITY') return prioritySort(left, right)
      const delta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      return sort === 'NEWEST' ? delta : -delta
    })
  }, [category, dependency, normalizedSearch, questions.items, sort, urgency])

  const hasFilters =
    normalizedSearch.length > 0 ||
    dependency !== 'ALL' ||
    urgency !== 'ALL' ||
    category !== 'ALL' ||
    sort !== 'PRIORITY'

  function clearFilters() {
    setSearch('')
    setDependency('ALL')
    setUrgency('ALL')
    setCategory('ALL')
    setSort('PRIORITY')
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-xl border border-amber-200 bg-white/80 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(14rem,1.5fr)_repeat(4,minmax(8rem,1fr))]">
          <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
            Find a question
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Question, source, or workflow"
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-200"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
            Dependency
            <select
              value={dependency}
              onChange={(event) => setDependency(event.target.value as typeof dependency)}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950"
            >
              <option value="ALL">All dependencies</option>
              <option value="BLOCKING">Blocks workflow</option>
              <option value="LOCAL">Local / advisory</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
            Urgency
            <select
              value={urgency}
              onChange={(event) => setUrgency(event.target.value as typeof urgency)}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950"
            >
              <option value="ALL">All urgency</option>
              <option value="URGENT">Urgent</option>
              <option value="HIGH">High</option>
              <option value="NORMAL">Normal</option>
              <option value="LOW">Low</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
            Source / type
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950"
            >
              <option value="ALL">All sources</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
            Order
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950"
            >
              <option value="PRIORITY">Blocking, urgency, age</option>
              <option value="NEWEST">Newest first</option>
              <option value="OLDEST">Oldest first</option>
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <p role="status">
            Showing {visible.length} of {questions.items.length} loaded open questions
            {questions.nextCursor ? '; additional older questions exist' : ''}.
          </p>
          {hasFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 font-semibold text-sky-800 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-amber-300 bg-white p-5 text-sm text-slate-600">
          No loaded open questions match these filters.
        </p>
      ) : (
        <div className="grid items-start gap-3 xl:grid-cols-2">
          {visible.map((question) => (
            <details
              key={question.id}
              className="group rounded-xl border border-amber-200 bg-white shadow-sm open:border-sky-300 open:ring-2 open:ring-sky-100"
            >
              <summary className="cursor-pointer list-none rounded-xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 [&::-webkit-details-marker]:hidden">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide">
                      <span
                        className={
                          question.blocking
                            ? 'rounded-full bg-rose-100 px-2 py-1 text-rose-900'
                            : 'rounded-full bg-sky-100 px-2 py-1 text-sky-900'
                        }
                      >
                        {question.blocking ? 'Blocks workflow' : 'Local / advisory'}
                      </span>
                      <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900">
                        {question.urgency.toLowerCase()}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">
                        {label(question.category)}
                      </span>
                    </div>
                    <p className="mt-2 text-base font-semibold leading-6 text-slate-950">
                      {question.question}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {question.agentIdentity.name}
                      {question.agentRun?.requestedOperation
                        ? ` · ${label(question.agentRun.requestedOperation)}`
                        : ''}{' '}
                      · {age(question.createdAt, generatedAt)}
                    </p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="mt-1 shrink-0 rounded-full border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 group-open:bg-slate-100"
                  >
                    <span className="group-open:hidden">Open</span>
                    <span className="hidden group-open:inline">Close</span>
                  </span>
                </div>
              </summary>
              <div className="border-t border-amber-100 px-4 pb-4 pt-3">
                {question.context ? (
                  <p className="text-sm leading-6 text-slate-700">{question.context}</p>
                ) : null}
                <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-slate-500">Created</dt>
                    <dd className="mt-0.5">{createdTime(question.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-500">Decision format</dt>
                    <dd className="mt-0.5">{label(question.questionType)}</dd>
                  </div>
                  {question.dueAt ? (
                    <div>
                      <dt className="font-semibold text-slate-500">Due</dt>
                      <dd className="mt-0.5 font-semibold text-amber-900">
                        {createdTime(question.dueAt)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <AgentQuestionEvidence
                  evidence={question.evidence}
                  proposedAnswer={question.proposedAnswer}
                />
                <AgentQuestionAnswerForm
                  tenantId={question.tenantId}
                  venueId={question.venueId}
                  questionId={question.id}
                  expectedUpdatedAt={question.updatedAt}
                  choices={question.choices}
                  recipients={[]}
                  canRouteToClient={false}
                />
                <Link
                  className="mt-3 inline-flex min-h-10 items-center text-sm font-semibold text-sky-700 underline decoration-sky-200 underline-offset-4"
                  href={`/admin/clients/${question.tenantId}/venues/${question.venueId}/agents#inbox`}
                >
                  Open full agent context
                </Link>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
