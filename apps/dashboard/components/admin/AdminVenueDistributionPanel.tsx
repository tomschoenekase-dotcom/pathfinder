'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTRPCClient } from '../../lib/trpc'
import { CopyAccessValueButton } from '../CopyAccessValueButton'

type Props = {
  tenantId: string
  venueId: string
  website: {
    state: 'ENABLED' | 'DISABLED'
    effective: boolean
    reason: string | null
    framed: boolean
    frameReason: string | null
  }
  app: { state: 'ENABLED' | 'DISABLED'; effective: boolean; reason: string | null }
  revision: number
  origins: Array<{
    id: string
    origin: string
    state: 'ACTIVE' | 'REVOKED'
    addedReason: string
    addedAt: string
    revokedReason: string | null
    revokedAt: string | null
  }>
  sessions30d: { direct: number; qr: number; website: number; app: number; unknown: number }
  artifacts: Array<{ label: string; value: string }>
  /** Active public places; partners map these IDs to `place` and `place-action`. */
  publicPlaces?: Array<{ id: string; name: string; type: string }>
  /** Place-button taps an app host accepted in the last 30 days. */
  appHandBacks30d?: number
  previewUrl: string | null
  proposals?: Array<{
    approvalRequestId: string
    reason: string
    createdAt: string
    expectedRevision: number
    change: {
      kind: 'ADD_ORIGIN' | 'REVOKE_ORIGIN' | 'SET_SURFACE'
      origin?: string
      surface?: 'WEBSITE' | 'APP'
      enabled?: boolean
    }
  }>
}

function csvCell(value: string) {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function placeIdsCsv(places: NonNullable<Props['publicPlaces']>) {
  return [
    'place_id,name,type',
    ...places.map((place) => [place.id, place.name, place.type].map(csvCell).join(',')),
  ].join('\n')
}

export function AdminVenueDistributionPanel(props: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [origin, setOrigin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [revision, setRevision] = useState(props.revision)
  const [surface, setSurface] = useState({ website: props.website.state, app: props.app.state })
  const [originRows, setOriginRows] = useState(props.origins)
  const [applyingProposal, setApplyingProposal] = useState<string | null>(null)

  async function mutate(action: () => Promise<unknown>, success: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      setNotice(success)
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The change could not be saved. Refresh and try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  function setState(target: 'website' | 'app') {
    if (!reason.trim()) {
      setError('Add a reason before changing a surface.')
      return
    }
    const state = surface[target] === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    void mutate(
      async () => {
        const result = await client.admin.venueDistribution.setSurfaceState.mutate({
          tenantId: props.tenantId,
          venueId: props.venueId,
          surface: target,
          state,
          reason: reason.trim(),
        })
        setSurface((current) => ({ ...current, [target]: state }))
        setRevision(result.revision)
      },
      `${target === 'app' ? 'App' : 'Website'} access ${state.toLowerCase()}.`,
    )
  }

  function addOrigin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!reason.trim()) {
      setError('Add a reason before adding an origin.')
      return
    }
    void mutate(async () => {
      const result = await client.admin.venueDistribution.addOrigin.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        origin: origin.trim(),
        reason: reason.trim(),
      })
      setOriginRows((rows) => [
        ...rows,
        {
          ...result,
          state: 'ACTIVE',
          addedReason: reason.trim(),
          addedAt: new Date().toISOString(),
          revokedReason: null,
          revokedAt: null,
        },
      ])
      setRevision(result.revision)
      setOrigin('')
    }, 'Website origin added.')
  }

  function revokeOrigin(originId: string) {
    if (!reason.trim()) {
      setError('Add a reason before revoking an origin.')
      return
    }
    void mutate(async () => {
      const result = await client.admin.venueDistribution.revokeOrigin.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        originId,
        reason: reason.trim(),
      })
      setOriginRows((rows) =>
        rows.map((row) =>
          row.id === originId
            ? {
                ...row,
                state: 'REVOKED',
                revokedReason: reason.trim(),
                revokedAt: new Date().toISOString(),
              }
            : row,
        ),
      )
      if (result.revision !== null) setRevision(result.revision)
    }, 'Website origin revoked.')
  }

  async function applyProposal(approvalRequestId: string) {
    if (applyingProposal) return
    setApplyingProposal(approvalRequestId)
    setError(null)
    setNotice(null)
    try {
      await client.admin.venueDistribution.applyProposal.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        approvalRequestId,
      })
      setNotice('Approved distribution proposal applied.')
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The proposal could not be applied. Refresh and review its current state.',
      )
    } finally {
      setApplyingProposal(null)
    }
  }

  const status = (enabled: boolean) => (enabled ? 'Enabled' : 'Disabled')
  return (
    <div className="space-y-8">
      <section
        className="grid gap-5 rounded-2xl border border-pf-light bg-pf-white p-5 sm:grid-cols-2"
        aria-label="Visitor access surfaces"
      >
        {(['website', 'app'] as const).map((target) => {
          const data = target === 'website' ? props.website : props.app
          return (
            <div
              key={target}
              className="flex flex-col gap-3 border-b border-pf-light pb-5 last:border-b-0 last:pb-0 sm:border-b-0 sm:pb-0 sm:pr-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-pf-deep">
                    {target === 'website' ? 'Website embedding' : 'App WebView'}
                  </h2>
                  <p className="mt-1 text-sm text-pf-deep/70">
                    {status(surface[target] === 'ENABLED')} ·{' '}
                    {data.effective ? 'Available' : `Unavailable: ${data.reason ?? 'not ready'}`}
                  </p>
                  {target === 'website' && !props.website.framed ? (
                    <p className="mt-1 text-sm text-amber-800">
                      Self framed preview only:{' '}
                      {props.website.frameReason ?? 'no active website origins'}.
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setState(target)}
                  className="min-h-11 shrink-0 rounded-full bg-pf-primary px-4 text-sm font-semibold text-white hover:bg-pf-accent disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
                >
                  {surface[target] === 'ENABLED' ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
          )
        })}
      </section>

      <section
        className="space-y-4 rounded-2xl border border-pf-light bg-pf-white p-5"
        aria-labelledby="distribution-origins-title"
      >
        <div>
          <h2 id="distribution-origins-title" className="text-lg font-semibold text-pf-deep">
            Allowed website origins
          </h2>
          <p className="mt-1 text-sm leading-6 text-pf-deep/70">
            Use an exact HTTPS origin, such as https://museum.example. Changes affect new page loads
            within about 30 seconds.
          </p>
        </div>
        <form onSubmit={addOrigin} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className="sr-only" htmlFor="distribution-origin">
            Website origin
          </label>
          <input
            id="distribution-origin"
            type="url"
            inputMode="url"
            placeholder="https://museum.example"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            className="min-h-11 rounded-xl border border-pf-light px-3 text-sm text-pf-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-pf-primary"
          />
          <button
            type="submit"
            disabled={busy || !origin.trim()}
            className="min-h-11 rounded-full border border-pf-primary px-5 text-sm font-semibold text-pf-primary hover:bg-pf-surface disabled:opacity-50"
          >
            Add origin
          </button>
        </form>
        <ul className="divide-y divide-pf-light">
          {originRows.map((row) => (
            <li
              key={row.id}
              className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="break-all font-medium text-pf-deep">
                  {row.origin}{' '}
                  <span
                    className={`ml-2 inline-flex rounded-full px-2 py-0.5 text-xs ${row.state === 'ACTIVE' ? 'bg-emerald-50 text-emerald-800' : 'bg-pf-surface text-pf-deep/70'}`}
                  >
                    {row.state.toLowerCase()}
                  </span>
                </p>
                <p className="mt-1 text-xs text-pf-deep/70">
                  Added {new Date(row.addedAt).toLocaleDateString()} · {row.addedReason}
                  {row.revokedAt
                    ? ` · Revoked ${new Date(row.revokedAt).toLocaleDateString()}: ${row.revokedReason}`
                    : ''}
                </p>
              </div>
              {row.state === 'ACTIVE' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => revokeOrigin(row.id)}
                  className="min-h-10 self-start rounded-full border border-pf-light px-4 text-sm font-medium text-pf-deep hover:bg-pf-surface disabled:opacity-50"
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {originRows.length === 0 ? (
          <p className="text-sm text-pf-deep/70">
            No website origins are allowed. The visitor page can still be previewed from this site
            when website access is enabled.
          </p>
        ) : null}
      </section>

      <section className="space-y-4" aria-labelledby="distribution-artifacts-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="distribution-artifacts-title" className="text-lg font-semibold text-pf-deep">
              Visitor links and snippets
            </h2>
            <p className="mt-1 text-sm text-pf-deep/70">
              Copy the value that matches where visitors will open Torchiko.
            </p>
          </div>
          <span className="text-xs text-pf-deep/60">Policy revision {revision}</span>
        </div>
        {props.previewUrl ? (
          <a
            href={props.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white hover:bg-pf-accent"
          >
            Preview visitor page
          </a>
        ) : (
          <p className="text-sm text-amber-800">
            Visitor links are unavailable because the public web origin is not configured.
          </p>
        )}
        <div className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-pf-white px-4">
          {props.artifacts.map((artifact) => (
            <div
              key={artifact.label}
              className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-pf-deep">{artifact.label}</h3>
                <code className="mt-1 block break-all whitespace-pre-wrap text-xs leading-5 text-pf-deep/75">
                  {artifact.value}
                </code>
              </div>
              <CopyAccessValueButton label={artifact.label.toLowerCase()} value={artifact.value} />
            </div>
          ))}
          {props.artifacts.length === 0 ? (
            <p className="py-4 text-sm text-pf-deep/70">
              Links are unavailable in this environment.
            </p>
          ) : null}
        </div>
      </section>

      {props.publicPlaces ? (
        <section className="space-y-4" aria-labelledby="distribution-places-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="distribution-places-title" className="text-lg font-semibold text-pf-deep">
                Place IDs for app and website hosts
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-pf-deep/70">
                Partners use these public IDs to open the guide on one place with{' '}
                <code>place=</code>, and to map the guide&apos;s Open in app button back to their
                own screens. Only active public places are listed.
              </p>
            </div>
            {props.publicPlaces.length ? (
              <CopyAccessValueButton
                label="place list (CSV)"
                value={placeIdsCsv(props.publicPlaces)}
              />
            ) : null}
          </div>
          {props.publicPlaces.length ? (
            <ul className="max-h-96 divide-y divide-pf-light overflow-y-auto rounded-2xl border border-pf-light bg-pf-white px-4">
              {props.publicPlaces.map((place) => (
                <li
                  key={place.id}
                  className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <span className="min-w-0 text-sm font-medium text-pf-deep">
                    {place.name}{' '}
                    <span className="text-xs font-normal text-pf-deep/60">
                      {place.type.toLowerCase().replaceAll('_', ' ')}
                    </span>
                  </span>
                  <code className="break-all text-xs text-pf-deep/75">{place.id}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-2xl border border-pf-light bg-pf-white px-4 py-4 text-sm text-pf-deep/70">
              This venue has no active public places yet.
            </p>
          )}
        </section>
      ) : null}

      {props.proposals?.length ? (
        <section className="space-y-4" aria-labelledby="distribution-proposals-title">
          <div>
            <h2 id="distribution-proposals-title" className="text-lg font-semibold text-pf-deep">
              Agent proposals awaiting review
            </h2>
            <p className="mt-1 text-sm leading-6 text-pf-deep/70">
              Applying checks the venue scope and current policy revision again. Stale proposals
              must be reviewed against the latest settings.
            </p>
          </div>
          <ul className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-pf-white px-4">
            {props.proposals.map((proposal) => (
              <li
                key={proposal.approvalRequestId}
                className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-pf-deep">
                    {proposal.change.kind.replaceAll('_', ' ').toLowerCase()}
                  </p>
                  <code className="mt-1 block break-all text-xs text-pf-deep/75">
                    {JSON.stringify(proposal.change)}
                  </code>
                  <p className="mt-2 text-sm text-pf-deep/75">{proposal.reason}</p>
                  <p className="mt-1 text-xs text-pf-deep/60">
                    Submitted {new Date(proposal.createdAt).toLocaleString()} · expected revision{' '}
                    {proposal.expectedRevision}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={applyingProposal !== null || proposal.expectedRevision !== revision}
                  onClick={() => void applyProposal(proposal.approvalRequestId)}
                  className="min-h-11 shrink-0 rounded-full bg-pf-primary px-5 text-sm font-semibold text-white hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {applyingProposal === proposal.approvalRequestId
                    ? 'Applying…'
                    : proposal.expectedRevision !== revision
                      ? 'Refresh to review'
                      : 'Apply proposal'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className="space-y-3 rounded-2xl border border-pf-light bg-pf-surface/45 p-5"
        aria-labelledby="distribution-sessions-title"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="distribution-sessions-title" className="text-lg font-semibold text-pf-deep">
            Visitor sessions
          </h2>
          <p className="text-xs text-pf-deep/60">Last 30 days · policy revision {revision}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-5">
          {Object.entries(props.sessions30d).map(([label, value]) => (
            <div key={label}>
              <dt className="capitalize text-pf-deep/70">{label}</dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-pf-deep">{value}</dd>
            </div>
          ))}
        </dl>
        {props.appHandBacks30d !== undefined ? (
          <p className="border-t border-pf-light pt-3 text-sm text-pf-deep/75">
            Sent back to the partner app:{' '}
            <strong className="font-semibold tabular-nums text-pf-deep">
              {props.appHandBacks30d}
            </strong>{' '}
            taps on the app&apos;s place button
          </p>
        ) : null}
      </section>

      <label
        className="block max-w-2xl text-sm font-medium text-pf-deep"
        htmlFor="distribution-reason"
      >
        Reason recorded in the audit log
        <textarea
          id="distribution-reason"
          required
          minLength={1}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          className="mt-2 block w-full rounded-xl border border-pf-light bg-white px-3 py-2 text-sm font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-pf-primary"
        />
      </label>
      {error ? (
        <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
