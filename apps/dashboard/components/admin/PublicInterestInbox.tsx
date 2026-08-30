'use client'

import React, { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

import { useTRPCClient } from '../../lib/trpc'

type Inbox = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listPublicInterestSubmissions']['query']>
>
type InboxItem = Inbox['items'][number]
type Filter = 'ALL' | 'NEW' | 'REVIEWED' | 'ARCHIVED'

export function PublicInterestInbox() {
  const client = useTRPCClient()
  const [filter, setFilter] = useState<Filter>('NEW')
  const [inbox, setInbox] = useState<Inbox | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ organizationId: string; name: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setInbox(
        await client.admin.listPublicInterestSubmissions.query({
          ...(filter === 'ALL' ? {} : { status: filter }),
          limit: 100,
        }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load inbound requests.')
    }
  }, [client, filter])

  useEffect(() => void load(), [load])

  async function review(item: InboxItem, decision: 'MARK_REVIEWED' | 'ARCHIVE' | 'REOPEN') {
    setBusyId(item.id)
    setError(null)
    setNotice(null)
    try {
      await client.admin.reviewPublicInterestSubmission.mutate({
        operationId: crypto.randomUUID(),
        submissionId: item.id,
        decision,
        reason:
          decision === 'ARCHIVE'
            ? 'Archived from the inbound interest inbox.'
            : decision === 'REOPEN'
              ? 'Reopened for another review.'
              : 'Reviewed in the inbound interest inbox.',
      })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the request.')
    } finally {
      setBusyId(null)
    }
  }

  async function createProspect(item: InboxItem) {
    setBusyId(item.id)
    setError(null)
    setNotice(null)
    try {
      const converted = await client.admin.convertPublicInterestSubmissionToProspect.mutate({
        operationId: crypto.randomUUID(),
        submissionId: item.id,
        reason: 'Converted after human review in the inbound interest inbox.',
      })
      await load()
      setNotice({
        organizationId: converted.organization.id,
        name: converted.organization.canonicalName,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the prospect.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Link href="/admin/prospects" className="text-sm font-semibold text-sky-700">
            ← Prospect CRM
          </Link>
          <p className="mt-4 text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
            Provider-dark intake
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            Inbound interest
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Public requests stay staged here until a platform administrator reconciles them.
            Creating a prospect records the organization, venue, contact, and source evidence only.
            It never contacts anyone, sets a price, creates a customer account, starts onboarding,
            or bills.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm"
        >
          Refresh
        </button>
      </header>

      <nav aria-label="Inbound request status" className="flex flex-wrap gap-2">
        {(['NEW', 'REVIEWED', 'ARCHIVED', 'ALL'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setNotice(null)
              setFilter(value)
            }}
            aria-pressed={filter === value}
            className={`rounded-full px-4 py-2 text-sm font-semibold ${filter === value ? 'bg-slate-950 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}
          >
            {value === 'ALL' ? 'All' : value.charAt(0) + value.slice(1).toLowerCase()}
            {value !== 'ALL' && inbox?.counts[value] !== undefined
              ? ` (${inbox.counts[value]})`
              : ''}
          </button>
        ))}
      </nav>

      {error ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950 sm:flex-row sm:items-center sm:justify-between"
        >
          <span>Created {notice.name} in the prospect CRM. No communication was sent.</span>
          <Link
            href={`/admin/prospects/${notice.organizationId}`}
            className="font-bold text-emerald-900 underline underline-offset-2"
          >
            View prospect
          </Link>
        </div>
      ) : null}
      {!inbox && !error ? (
        <div
          role="status"
          className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600"
        >
          Loading inbound requests…
        </div>
      ) : null}
      {inbox && inbox.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600">
          No {filter === 'ALL' ? '' : filter.toLowerCase()} inbound requests.
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {inbox?.items.map((item) => (
          <article
            key={item.id}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-lg font-bold text-slate-950">{item.organizationName}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {item.contactName} · <span className="font-semibold">{item.workEmail}</span>
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
                {item.status}
              </span>
            </div>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-slate-500">Venue type</dt>
                <dd className="mt-1 text-slate-900">{item.venueType ?? 'Not provided'}</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-500">Location</dt>
                <dd className="mt-1 text-slate-900">{item.cityRegion ?? 'Not provided'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-semibold text-slate-500">Submitted</dt>
                <dd className="mt-1 text-slate-900">
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(item.createdAt)}
                </dd>
              </div>
            </dl>
            {item.website ? (
              <a
                href={item.website}
                target="_blank"
                rel="noreferrer"
                className="mt-4 block break-all text-sm font-semibold text-sky-700 underline underline-offset-2"
              >
                {item.website}
              </a>
            ) : null}
            {item.message ? (
              <p className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                {item.message}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-2">
              {!item.prospectConversion && item.status !== 'ARCHIVED' ? (
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => void createProspect(item)}
                  className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busyId === item.id ? 'Working…' : 'Create prospect'}
                </button>
              ) : null}
              {item.prospectConversion ? (
                <Link
                  href={`/admin/prospects/${item.prospectConversion.organizationId}`}
                  className="rounded-xl bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800"
                >
                  View {item.prospectConversion.organization.canonicalName}
                </Link>
              ) : null}
              {item.status !== 'REVIEWED' ? (
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => void review(item, 'MARK_REVIEWED')}
                  className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Mark reviewed
                </button>
              ) : null}
              {item.status !== 'ARCHIVED' ? (
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => void review(item, 'ARCHIVE')}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
                >
                  Archive
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => void review(item, 'REOPEN')}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
                >
                  Reopen
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
