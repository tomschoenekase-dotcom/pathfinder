import Link from 'next/link'

import { formatWhen } from './format'
import type { OperatorAuditRowView } from './types'

export const AUDIT_EVENT_TYPES = [
  'mcp.call',
  'mcp.denied',
  'oauth.register',
  'oauth.arm',
  'oauth.authorize',
  'oauth.token',
  'oauth.refresh',
  'oauth.reuse_detected',
  'oauth.revoke',
  'proposal.transition',
  'plan.transition',
  'proposal.recovery',
  'autonomy.change',
  'decision.request',
  'job_grant.change',
] as const

export type AuditFilterValues = {
  eventType: string
  outcome: string
  tool: string
  days: string
}

const field =
  'mt-1 block min-h-11 w-full rounded-lg border border-slate-400 bg-white px-3 text-sm text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500'

/** Filter form (plain GET) and the newest 100 rows. Arguments are redacted before they get here. */
export function OperatorAudit({
  rows,
  filters,
}: {
  rows: readonly OperatorAuditRowView[]
  filters: AuditFilterValues
}) {
  return (
    <div className="space-y-4">
      <form
        method="get"
        action="/admin/operator"
        aria-label="Filter the audit log"
        className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end"
      >
        <input type="hidden" name="tab" value="audit" />
        <label className="block text-sm font-medium text-slate-900">
          Event
          <select name="eventType" defaultValue={filters.eventType} className={field}>
            <option value="">All events</option>
            {AUDIT_EVENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-900">
          Outcome
          <input name="outcome" defaultValue={filters.outcome} maxLength={64} className={field} />
        </label>
        <label className="block text-sm font-medium text-slate-900">
          Tool
          <input name="tool" defaultValue={filters.tool} maxLength={120} className={field} />
        </label>
        <label className="block text-sm font-medium text-slate-900">
          Period
          <select name="days" defaultValue={filters.days} className={field}>
            <option value="">All time</option>
            <option value="1">Last day</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            className="min-h-11 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
          >
            Apply
          </button>
          <Link
            href="/admin/operator?tab=audit"
            className="inline-flex min-h-11 items-center rounded-xl border border-slate-400 px-4 text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Clear
          </Link>
        </div>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
          No audit events match these filters.
        </p>
      ) : (
        <div
          role="region"
          aria-label="Audit events"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border border-slate-200 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <table className="w-full min-w-[46rem] text-left text-sm">
            <caption className="sr-only">
              Newest 100 operator audit events. Arguments are redacted.
            </caption>
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-700">
              <tr>
                <th scope="col" className="px-3 py-2">
                  When
                </th>
                <th scope="col" className="px-3 py-2">
                  Event
                </th>
                <th scope="col" className="px-3 py-2">
                  Outcome
                </th>
                <th scope="col" className="px-3 py-2">
                  Tool and target
                </th>
                <th scope="col" className="px-3 py-2">
                  Redacted arguments
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 align-top">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-800">
                    {formatWhen(row.occurredAt)}
                  </td>
                  <td className="px-3 py-2 font-medium text-slate-950">
                    {row.eventType}
                    {row.clientName ? (
                      <span className="block text-xs font-normal text-slate-600">
                        {row.clientName}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-slate-800">{row.outcome}</td>
                  <td className="px-3 py-2 text-slate-800">
                    {row.tool ?? 'none'}
                    {row.tenantName ? (
                      <span className="block text-xs text-slate-600">
                        {row.tenantName}
                        {row.venueName ? ` · ${row.venueName}` : ''}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {row.redactedArgs ? (
                      <details>
                        <summary className="cursor-pointer text-xs font-medium text-slate-700">
                          Show
                        </summary>
                        <pre className="mt-1 max-w-xs whitespace-pre-wrap break-all text-xs text-slate-800">
                          {row.redactedArgs}
                        </pre>
                      </details>
                    ) : (
                      <span className="text-slate-600">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
