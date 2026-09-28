import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ArrowRightLeft, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react'
import { isFeatureEnabled } from '@pathfinder/config/feature-flags'

type PartnerAccessPageProps = { params: Promise<{ tenantId: string }> }

const capabilities = [
  'clients:read',
  'venues:read',
  'approved-content:read',
  'configuration:read',
  'readiness:read',
  'updates:read',
]

export default async function PartnerAccessPage({ params }: PartnerAccessPageProps) {
  if (!isFeatureEnabled('partnerReadApi')) notFound()

  const { tenantId } = await params
  const clientHref = `/admin/clients/${encodeURIComponent(tenantId)}`

  return (
    <div className="space-y-8">
      <Link
        className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-pf-primary hover:text-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        href={clientHref}
      >
        <ArrowLeft aria-hidden="true" size={16} />
        Client workspace
      </Link>

      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Partner API · v1
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">Partner access</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Manage scoped keys for approved partner integrations. Each key is limited to this client
          and the read capabilities selected at issue time.
        </p>
        <p className="mt-3 text-xs text-pf-deep/60">
          Client{' '}
          <code className="max-w-full break-all rounded bg-pf-surface px-1.5 py-1 text-pf-deep">
            {tenantId}
          </code>
        </p>
      </header>

      <section
        className="rounded-2xl border border-amber-200 bg-amber-50 p-5"
        aria-labelledby="connection-title"
      >
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 shrink-0 text-amber-800" aria-hidden="true" size={18} />
          <div>
            <h2 id="connection-title" className="font-semibold text-amber-950">
              Key management is not connected
            </h2>
            <p className="mt-1 text-sm leading-6 text-amber-950">
              The v1 credential service is available, but no platform-admin procedures expose it to
              this page yet. Nothing is being loaded or changed here.
            </p>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(20rem,0.95fr)]">
        <section
          className="min-w-0 rounded-2xl border border-pf-light bg-white p-5 sm:p-6"
          aria-labelledby="inventory-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.15em] text-pf-primary">
                Credential inventory
              </p>
              <h2 id="inventory-title" className="mt-1 text-lg font-semibold text-pf-deep">
                Keys for this client
              </h2>
            </div>
            <p className="text-xs font-semibold text-pf-deep/60">Not loaded</p>
          </div>

          <div className="flex min-h-56 flex-col items-center justify-center px-3 py-8 text-center">
            <KeyRound className="text-pf-primary/70" aria-hidden="true" size={22} />
            <h3 className="mt-4 max-w-sm text-sm font-semibold text-pf-deep">
              Connect the admin read procedure to view keys
            </h3>
            <p className="mt-2 max-w-lg text-sm leading-6 text-pf-deep/70">
              This view will show safe metadata only: label, environment, scope, state, issue date,
              expiry, and last use. Secret material is never part of the inventory.
            </p>
          </div>

          <div
            className="flex flex-wrap gap-3 border-t border-pf-light pt-4"
            aria-label="Key lifecycle actions"
          >
            <button
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-pf-light px-4 text-sm font-semibold text-pf-deep/60 disabled:cursor-not-allowed disabled:opacity-60"
              disabled
              type="button"
            >
              <ArrowRightLeft aria-hidden="true" size={15} />
              Rotate selected
            </button>
            <button
              className="min-h-11 rounded-xl border border-rose-200 px-4 text-sm font-semibold text-rose-900 disabled:cursor-not-allowed disabled:opacity-60"
              disabled
              type="button"
            >
              Revoke selected
            </button>
          </div>
        </section>

        <section
          className="min-w-0 rounded-2xl border border-pf-light bg-white p-5 sm:p-6"
          aria-labelledby="issue-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.15em] text-pf-primary">
                Issue a key
              </p>
              <h2 id="issue-title" className="mt-1 text-lg font-semibold text-pf-deep">
                New partner key
              </h2>
            </div>
            <p className="text-xs font-semibold text-pf-deep/60">Unavailable</p>
          </div>

          <p className="mt-3 text-sm leading-6 text-pf-deep/70">
            When available, this form will capture an operator label, venue scope, selected
            capabilities, and expiry. The server selects the environment; capabilities below are
            shown for reference only.
          </p>

          <fieldset
            className="mt-4 min-w-0 border-0 p-0"
            disabled
            aria-describedby="form-disabled-note"
          >
            <legend className="sr-only">New partner key details</legend>
            <label className="mb-1.5 block text-xs font-bold text-pf-deep" htmlFor="key-label">
              Key label
            </label>
            <input
              id="key-label"
              className="min-h-11 w-full rounded-lg border border-pf-light bg-pf-surface px-3 text-sm text-pf-deep placeholder:text-pf-deep/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              placeholder="e.g. Monthly reporting"
            />

            <div className="mt-4 flex min-h-11 items-center justify-between gap-3 rounded-lg border border-pf-light bg-pf-surface px-3 text-xs">
              <span className="font-bold text-pf-deep">Environment</span>
              <span className="text-pf-deep/70">Set by server configuration</span>
            </div>

            <p className="mb-2 mt-4 text-xs font-bold text-pf-deep">
              Available v1 read capabilities · reference only
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {capabilities.map((capability) => (
                <li
                  key={capability}
                  className="flex min-h-10 items-center gap-2 border-l-2 border-pf-primary/30 bg-pf-surface px-3 text-xs text-pf-deep"
                >
                  <ShieldCheck className="shrink-0 text-pf-primary" aria-hidden="true" size={14} />
                  <code>{capability}</code>
                </li>
              ))}
            </ul>

            <label
              className="mb-1.5 mt-4 block text-xs font-bold text-pf-deep"
              htmlFor="key-expiry"
            >
              Expiry <span className="font-normal text-pf-deep/60">(optional)</span>
            </label>
            <input
              id="key-expiry"
              className="min-h-11 w-full rounded-lg border border-pf-light bg-pf-surface px-3 text-sm text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              type="date"
            />
            <button
              className="mt-4 min-h-11 w-full rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-55"
              type="button"
            >
              Create key
            </button>
          </fieldset>
          <p
            className="mt-3 border-l-2 border-amber-300 pl-3 text-xs leading-5 text-pf-deep/70"
            id="form-disabled-note"
          >
            Creation stays disabled until tenant and venue scope, actor identity, audit evidence,
            and one-time secret delivery are enforced by the admin endpoint.
          </p>
        </section>
      </div>

      <section
        className="grid gap-4 rounded-2xl border border-pf-light bg-pf-surface p-5 sm:grid-cols-3"
        aria-label="Credential handling"
      >
        <div className="flex items-start gap-2 text-sm text-pf-deep/70">
          <ShieldCheck className="mt-0.5 shrink-0 text-pf-primary" aria-hidden="true" size={17} />
          <span>
            <strong className="block text-pf-deep">Tenant bound</strong>Every operation must check
            this client scope on the server.
          </span>
        </div>
        <div className="flex items-start gap-2 text-sm text-pf-deep/70">
          <KeyRound className="mt-0.5 shrink-0 text-pf-primary" aria-hidden="true" size={17} />
          <span>
            <strong className="block text-pf-deep">Shown once</strong>New key material must never be
            stored or returned again.
          </span>
        </div>
        <div className="flex items-start gap-2 text-sm text-pf-deep/70">
          <ArrowRightLeft
            className="mt-0.5 shrink-0 text-pf-primary"
            aria-hidden="true"
            size={17}
          />
          <span>
            <strong className="block text-pf-deep">Audited lifecycle</strong>Rotation and revocation
            need explicit operator evidence.
          </span>
        </div>
      </section>
    </div>
  )
}
