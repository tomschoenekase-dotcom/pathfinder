'use client'

import Link from 'next/link'
import React, { useMemo, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'
import { AgentQuestionAnswerForm } from './AgentQuestionAnswerForm'
import { AgentQuestionDiscussion } from './AgentQuestionDiscussion'
import { AgentQuestionEvidence } from './AgentQuestionEvidence'

type Attention = inferRouterOutputs<AppRouter>['admin']['attentionConsole']
type Question = Attention['questions']['items'][number]
type ViewMode = 'INDIVIDUAL' | 'WORKFLOW'
type WorkflowGroup =
  | { kind: 'individual'; key: string; questions: [Question] }
  | {
      kind: 'workflow'
      key: string
      tenantId: string
      venueId: string
      agentRunId: string
      requestedOperation: string
      venueName: string
      questions: Question[]
    }

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

function dueLabel(dueAt: Date | string, generatedAt: Date | string) {
  const remainingMs = new Date(dueAt).getTime() - new Date(generatedAt).getTime()
  if (remainingMs < 0) return 'Overdue'
  if (remainingMs === 0) return 'Due now'
  const remainingHours = Math.ceil(remainingMs / 3_600_000)
  if (remainingHours < 24) return `Due in ${remainingHours}h`
  return `Due in ${Math.ceil(remainingHours / 24)}d`
}

function prioritySort(left: Question, right: Question) {
  const urgent = Number(right.urgency === 'URGENT') - Number(left.urgency === 'URGENT')
  if (urgent !== 0) return urgent
  if (left.blocking !== right.blocking) return left.blocking ? -1 : 1
  const urgency = urgencyRank[right.urgency] - urgencyRank[left.urgency]
  if (urgency !== 0) return urgency
  const created = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  return created || left.id.localeCompare(right.id)
}

function compareQuestions(sort: 'PRIORITY' | 'NEWEST' | 'OLDEST') {
  return (left: Question, right: Question) => {
    if (sort === 'PRIORITY') return prioritySort(left, right)
    const delta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    return sort === 'NEWEST' ? delta : -delta
  }
}

export function groupQuestionsByWorkflow(questions: Question[]): WorkflowGroup[] {
  const groups = new Map<string, WorkflowGroup>()
  for (const question of questions) {
    if (!question.agentRunId) {
      groups.set(`individual:${question.id}`, {
        kind: 'individual',
        key: `individual:${question.id}`,
        questions: [question],
      })
      continue
    }
    const key = `workflow:${JSON.stringify([question.tenantId, question.venueId, question.agentRunId])}`
    const existing = groups.get(key)
    if (existing?.kind === 'workflow') {
      existing.questions.push(question)
      continue
    }
    groups.set(key, {
      kind: 'workflow',
      key,
      tenantId: question.tenantId,
      venueId: question.venueId,
      agentRunId: question.agentRunId,
      requestedOperation: question.agentRun?.requestedOperation ?? 'Requested workflow',
      venueName: question.venue.name,
      questions: [question],
    })
  }
  return [...groups.values()]
}

export function FounderQuestionTriageBoard({
  actorId,
  questions,
  generatedAt,
}: {
  actorId?: string | null | undefined
  questions: Attention['questions']
  generatedAt: Attention['generatedAt']
}) {
  const [search, setSearch] = useState('')
  const [dependency, setDependency] = useState<'ALL' | 'BLOCKING' | 'LOCAL'>('ALL')
  const [urgency, setUrgency] = useState<'ALL' | Question['urgency']>('ALL')
  const [category, setCategory] = useState('ALL')
  const [sort, setSort] = useState<'PRIORITY' | 'NEWEST' | 'OLDEST'>('PRIORITY')
  const [viewMode, setViewMode] = useState<ViewMode>('INDIVIDUAL')

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
        question.venue.name,
        question.agentRun?.requestedOperation,
      ]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLocaleLowerCase().includes(normalizedSearch))
    })
    return [...filtered].sort(compareQuestions(sort))
  }, [category, dependency, normalizedSearch, questions.items, sort, urgency])
  const workflowGroups = useMemo(() => groupQuestionsByWorkflow(visible), [visible])
  const visibleQuestionIds = useMemo(
    () => new Set(visible.map((question) => question.id)),
    [visible],
  )
  const hiddenQuestions = useMemo(
    () => questions.items.filter((question) => !visibleQuestionIds.has(question.id)),
    [questions.items, visibleQuestionIds],
  )

  const hasFilters =
    normalizedSearch.length > 0 ||
    dependency !== 'ALL' ||
    urgency !== 'ALL' ||
    category !== 'ALL' ||
    sort !== 'PRIORITY'
  const visibleEntries =
    viewMode === 'INDIVIDUAL'
      ? visible.map((question) => (
          <QuestionCard
            key={question.id}
            actorId={actorId}
            question={question}
            generatedAt={generatedAt}
          />
        ))
      : workflowGroups.flatMap((group) =>
          group.kind === 'individual'
            ? [
                <IndependentQuestionHeading
                  key={`${group.key}:heading`}
                  question={group.questions[0]}
                />,
                <QuestionCard
                  key={group.questions[0].id}
                  actorId={actorId}
                  question={group.questions[0]}
                  generatedAt={generatedAt}
                />,
              ]
            : [
                <WorkflowGroupHeading key={`${group.key}:heading`} group={group} />,
                ...group.questions.map((question) => (
                  <QuestionCard
                    key={question.id}
                    actorId={actorId}
                    question={question}
                    generatedAt={generatedAt}
                  />
                )),
              ],
        )
  const questionEntries = [
    ...visibleEntries,
    ...hiddenQuestions.map((question) => (
      <QuestionCard
        key={question.id}
        actorId={actorId}
        question={question}
        generatedAt={generatedAt}
        hidden
      />
    )),
  ]

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
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(14rem,1.5fr)_repeat(4,minmax(8rem,1fr))]">
          <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
            Find a question
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Question, source, or workflow"
              className="min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-200"
            />
          </label>
          <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
            Dependency
            <select
              value={dependency}
              onChange={(event) => setDependency(event.target.value as typeof dependency)}
              className="min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950"
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
              className="min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950"
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
              className="min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950"
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
              className="min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-950"
            >
              <option value="PRIORITY">Urgent, then blocking, urgency, age</option>
              <option value="NEWEST">Newest first</option>
              <option value="OLDEST">Oldest first</option>
            </select>
          </label>
        </div>
        <fieldset className="mt-3 flex min-w-0 flex-wrap gap-2" aria-label="Question display">
          <legend className="sr-only">Question display</legend>
          <label className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800">
            <input
              type="radio"
              name="founder-question-display"
              value="INDIVIDUAL"
              checked={viewMode === 'INDIVIDUAL'}
              onChange={() => setViewMode('INDIVIDUAL')}
            />
            Individual questions
          </label>
          <label className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800">
            <input
              type="radio"
              name="founder-question-display"
              value="WORKFLOW"
              checked={viewMode === 'WORKFLOW'}
              onChange={() => setViewMode('WORKFLOW')}
            />
            Group by workflow
          </label>
        </fieldset>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <p role="status">
            Showing {visible.length} matching questions from {questions.items.length} loaded open
            questions
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
      ) : null}
      <div className="grid items-start gap-3 xl:grid-cols-2">{questionEntries}</div>
    </div>
  )
}

function IndependentQuestionHeading({ question }: { question: Question }) {
  return (
    <div
      data-independent-question={question.id}
      className="border-y border-slate-200 py-3 xl:col-span-2"
    >
      <p className="text-xs font-bold uppercase tracking-wide text-slate-600">
        Independent question · {question.venue.name}
      </p>
    </div>
  )
}

function WorkflowGroupHeading({ group }: { group: Extract<WorkflowGroup, { kind: 'workflow' }> }) {
  return (
    <div
      data-workflow-group={group.key}
      className="flex flex-wrap items-center justify-between gap-2 border-y border-slate-200 py-3 xl:col-span-2"
    >
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-600">
          Workflow · {group.venueName}
        </p>
        <p className="mt-1 break-words text-sm font-semibold text-slate-950">
          {label(group.requestedOperation)}
        </p>
        <p className="mt-1 text-xs text-slate-600">
          {group.questions.length} matching loaded{' '}
          {group.questions.length === 1 ? 'question' : 'questions'} in this workflow.
        </p>
      </div>
      <Link
        className="inline-flex min-h-10 shrink-0 items-center text-sm font-semibold text-sky-800 underline decoration-sky-200 underline-offset-4"
        href={`/admin/clients/${encodeURIComponent(group.tenantId)}/venues/${encodeURIComponent(group.venueId)}/agents/runs/${encodeURIComponent(group.agentRunId)}`}
      >
        Open workflow
      </Link>
    </div>
  )
}

function QuestionCard({
  actorId,
  question,
  generatedAt,
  hidden = false,
}: {
  actorId?: string | null | undefined
  question: Question
  generatedAt: Date | string
  hidden?: boolean
}) {
  return (
    <details
      hidden={hidden}
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
              {question.dueAt ? (
                <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">
                  {dueLabel(question.dueAt, generatedAt)}
                </span>
              ) : null}
              {question.expiresAt ? (
                <span className="text-xs font-semibold text-amber-950">
                  Response closes {createdTime(question.expiresAt)}
                </span>
              ) : null}
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">
                {label(question.category)}
              </span>
            </div>
            <p className="mt-2 text-base font-semibold leading-6 text-slate-950">
              {question.question}
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {question.agentIdentity.name} · {question.venue.name}
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
              <dd className="mt-0.5 font-semibold text-amber-900">{createdTime(question.dueAt)}</dd>
            </div>
          ) : null}
        </dl>
        <AgentQuestionEvidence
          evidence={question.evidence}
          proposedAnswer={question.proposedAnswer}
        />
        <AgentQuestionAnswerForm
          actorId={actorId}
          tenantId={question.tenantId}
          venueId={question.venueId}
          questionId={question.id}
          expectedUpdatedAt={question.updatedAt}
          expiresAt={question.expiresAt}
          agentRunId={question.agentRunId}
          questionType={question.questionType}
          choices={question.choices}
          recipients={[]}
          canRouteToClient={false}
        />
        <AgentQuestionDiscussion
          tenantId={question.tenantId}
          venueId={question.venueId}
          questionId={question.id}
        />
        <Link
          className="mt-3 inline-flex min-h-10 items-center text-sm font-semibold text-sky-700 underline decoration-sky-200 underline-offset-4"
          href={`/admin/clients/${encodeURIComponent(question.tenantId)}/venues/${encodeURIComponent(question.venueId)}/agents#inbox`}
        >
          Open full agent context
        </Link>
      </div>
    </details>
  )
}
