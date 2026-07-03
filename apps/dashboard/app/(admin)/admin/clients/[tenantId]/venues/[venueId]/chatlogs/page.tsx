export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type AdminChatlogsPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{ from?: string; to?: string; notable?: string }>
}

function toStartIso(value?: string) {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : undefined
}

function toEndIso(value?: string) {
  return value ? new Date(`${value}T23:59:59.999Z`).toISOString() : undefined
}

export default async function AdminChatlogsPage({ params, searchParams }: AdminChatlogsPageProps) {
  const { tenantId, venueId } = await params
  const query = await searchParams
  const caller = await createAdminCaller()
  const result = await caller.admin.listVenueSessions({
    tenantId,
    venueId,
    dateFrom: toStartIso(query.from),
    dateTo: toEndIso(query.to),
    notableOnly: query.notable === 'on',
  })

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        Back to venue
      </Link>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Chatlog review</h1>
        <p className="mt-2 text-sm text-pf-deep/60">
          Browse visitor sessions, captured answers, and private admin notes.
        </p>
      </header>

      <form className="flex flex-wrap items-end gap-3 rounded-3xl border border-pf-light bg-pf-white p-5 shadow-sm">
        <label className="grid gap-2 text-sm font-medium text-pf-deep">
          From
          <input
            type="date"
            name="from"
            defaultValue={query.from}
            className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-2"
          />
        </label>
        <label className="grid gap-2 text-sm font-medium text-pf-deep">
          To
          <input
            type="date"
            name="to"
            defaultValue={query.to}
            className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-2"
          />
        </label>
        <label className="flex min-h-10 items-center gap-2 rounded-2xl border border-pf-light bg-pf-surface px-4 text-sm font-medium text-pf-deep">
          <input type="checkbox" name="notable" defaultChecked={query.notable === 'on'} />
          Notable only
        </label>
        <button
          type="submit"
          className="inline-flex min-h-10 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white"
        >
          Filter
        </button>
      </form>

      <div className="overflow-hidden rounded-2xl border border-pf-light bg-pf-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-pf-light text-xs uppercase tracking-wider text-pf-deep/40">
            <tr>
              <th className="px-4 py-3 font-semibold">Started</th>
              <th className="px-4 py-3 font-semibold">Messages</th>
              <th className="px-4 py-3 font-semibold">Answers</th>
              <th className="px-4 py-3 font-semibold">Notes</th>
              <th className="px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {result.sessions.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-pf-deep/60">
                  No sessions found.
                </td>
              </tr>
            ) : (
              result.sessions.map((session) => (
                <tr key={session.id} className="border-b border-pf-light/60 last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/clients/${tenantId}/venues/${venueId}/chatlogs/${session.id}`}
                      className="font-medium text-pf-primary hover:text-pf-accent"
                    >
                      {session.startedAt.toLocaleString()}
                    </Link>
                    <p className="mt-1 text-xs text-pf-deep/50">
                      Last active {session.lastActiveAt.toLocaleString()}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-pf-deep/70">{session.messageCount}</td>
                  <td className="px-4 py-3 text-pf-deep/70">
                    {session._count.engagementResponses}
                  </td>
                  <td className="px-4 py-3 text-pf-deep/70">{session._count.adminNotes}</td>
                  <td className="px-4 py-3">
                    {session.isNotable ? (
                      <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                        Notable
                      </span>
                    ) : (
                      <span className="text-pf-deep/40">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
