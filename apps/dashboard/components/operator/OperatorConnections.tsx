import Link from 'next/link'

import { agoLabel, formatWhen } from './format'
import { RevokeButton } from './RevokeButton'
import type { OperatorConnectionRow } from './types'

/** Connected apps with a Revoke button, and the way in for a new one. */
export function OperatorConnections({
  rows,
  now,
}: {
  rows: readonly OperatorConnectionRow[]
  now: Date
}) {
  return (
    <div className="space-y-5">
      <section
        aria-labelledby="connect-heading"
        className="flex flex-col gap-3 rounded-xl border border-slate-300 bg-white p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
      >
        <div>
          <h2 id="connect-heading" className="text-lg font-semibold text-slate-950">
            Connect the operator
          </h2>
          <p className="mt-1 max-w-prose text-sm text-slate-700">
            First you arm the connection with Face ID or a passkey, then you have 10 minutes to add
            the connector in ChatGPT; a consent page you did not start this way is refused.
          </p>
        </div>
        <Link
          href="/oauth/arm"
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
        >
          Start connecting
        </Link>
      </section>

      <section aria-labelledby="connections-heading">
        <h2 id="connections-heading" className="text-lg font-semibold text-slate-950">
          Connected apps
        </h2>
        {rows.length === 0 ? (
          <p className="mt-2 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
            No app has connected yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {rows.map((row) => (
              <li
                key={row.grantId}
                className="grid gap-3 p-4 sm:px-5 lg:grid-cols-[1.4fr_1fr_1fr_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <p className="break-words text-base font-semibold text-slate-950">
                    {row.clientName}
                  </p>
                  <p className="text-sm text-slate-700">
                    Returns to{' '}
                    <span className="break-all font-medium">{row.redirectHosts.join(', ')}</span>
                  </p>
                  <p className="text-xs text-slate-600">{row.scope}</p>
                </div>
                <div className="text-sm text-slate-800">
                  <p>Last used: {agoLabel(row.lastUsedAt, now)}</p>
                  <p className="text-xs text-slate-600">Connected {formatWhen(row.createdAt)}</p>
                </div>
                <div className="text-sm text-slate-800">
                  <p className="font-semibold capitalize">{row.status}</p>
                  <p className="text-xs text-slate-600">
                    {row.status === 'revoked'
                      ? `Revoked ${formatWhen(row.revokedAt)}`
                      : `Access ends ${formatWhen(row.expiresAt)}`}
                  </p>
                </div>
                <div>
                  {row.status === 'active' ? (
                    <RevokeButton grantId={row.grantId} clientName={row.clientName} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
