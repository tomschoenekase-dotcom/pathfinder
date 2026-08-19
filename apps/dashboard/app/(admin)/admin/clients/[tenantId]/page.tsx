export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { AdminAiCostBudgetForm } from '../../../../../components/admin/AdminAiCostBudgetForm'
import { AdminClientPlanForm } from '../../../../../components/admin/AdminClientPlanForm'
import { AdminClientStatusForm } from '../../../../../components/admin/AdminClientStatusForm'
import { AdminTriggerDigestButton } from '../../../../../components/admin/AdminTriggerDigestButton'
import { AdminTochiRolloutForm } from '../../../../../components/admin/AdminTochiRolloutForm'
import { createAdminCaller } from '../../../../../lib/admin-caller'
import { getStatusClasses } from '../../../../../lib/admin-status'

type AdminClientDetailPageProps = { params: Promise<{ tenantId: string }> }

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border-l-2 border-pf-primary/20 px-4 py-2 first:border-l-0 first:pl-0">
      <p className="text-[0.68rem] font-bold uppercase tracking-[0.15em] text-pf-deep/40">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">{value}</p>
    </div>
  )
}

function formatGuideMode(mode: string): string {
  return mode.replace(/_/g, ' ')
}

export default async function AdminClientDetailPage({ params }: AdminClientDetailPageProps) {
  const { tenantId } = await params
  const caller = await createAdminCaller()

  let data: Awaited<ReturnType<Awaited<ReturnType<typeof createAdminCaller>>['admin']['getClient']>>
  try {
    data = await caller.admin.getClient({ tenantId })
  } catch {
    return (
      <div className="rounded-2xl border border-pf-light bg-pf-white p-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-pf-deep">Client not found</h1>
        <p className="mt-2 text-sm text-pf-deep/60">
          This client record does not exist or is unavailable.
        </p>
        <Link
          href="/admin/directory"
          className="mt-5 inline-flex text-sm font-semibold text-pf-primary hover:text-pf-accent"
        >
          Return to directory
        </Link>
      </div>
    )
  }

  const { tenant, venues, engagement7d } = data
  const aiCostBudget = await caller.admin.getAiCostBudget({ tenantId })
  const tochiRollout = await caller.admin.getTochiRollout({ tenantId })
  const placesTotal = venues.reduce((total, venue) => total + venue._count.places, 0)
  const inactiveVenues = venues.filter((venue) => !venue.isActive)

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Account briefing
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
            Client overview
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-pf-deep/55">
            Account health, guest access, venue activity, and commercial controls in one operator
            view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${getStatusClasses(tenant.status)}`}
          >
            {tenant.status}
          </span>
          <span className="rounded-full bg-pf-surface px-3 py-1 text-xs font-medium text-pf-deep/60">
            {tenant.planTier} plan
          </span>
        </div>
      </header>

      {venues.length === 0 || inactiveVenues.length > 0 ? (
        <section
          className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3"
          aria-label="Needs attention"
        >
          <p className="text-sm font-semibold text-amber-950">Needs attention</p>
          <p className="mt-0.5 text-sm text-amber-900/75">
            {venues.length === 0
              ? 'No venue has been created. The client portal cannot reach a guest experience yet.'
              : `${inactiveVenues.length} venue${inactiveVenues.length === 1 ? ' is' : 's are'} paused and unavailable to guests.`}
          </p>
        </section>
      ) : (
        <section
          className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3"
          aria-label="Guest access status"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden="true" />
          <p className="text-sm font-medium text-emerald-950">
            Guest access is enabled for all {venues.length} venue
            {venues.length === 1 ? '' : 's'}. Content readiness still requires review.
          </p>
        </section>
      )}

      <section
        className="grid grid-cols-2 gap-y-5 rounded-2xl border border-pf-light bg-pf-surface/45 px-5 py-4 lg:grid-cols-4"
        aria-label="Client summary"
      >
        <Stat label="Venues" value={venues.length} />
        <Stat label="Guide items" value={placesTotal} />
        <Stat label="Sessions (7d)" value={engagement7d.sessions} />
        <Stat label="Messages (7d)" value={engagement7d.messages} />
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-pf-deep">Venues</h2>
          <p className="mt-1 text-sm text-pf-deep/55">
            Choose a venue to enter venue scope and access its operational tools.
          </p>
        </div>
        {venues.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-pf-light bg-pf-surface/40 p-8 text-center text-sm text-pf-deep/60">
            No venues yet.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {venues.map((venue) => (
              <Link
                key={venue.id}
                href={`/admin/clients/${tenantId}/venues/${venue.id}`}
                className="group flex flex-col gap-3 rounded-2xl border border-pf-light bg-pf-white p-5 transition hover:-translate-y-0.5 hover:border-pf-accent hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold tracking-tight text-pf-deep">
                    {venue.name}
                  </h3>
                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-[0.65rem] font-bold uppercase tracking-wider ${venue.isActive ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}
                  >
                    {venue.isActive ? 'Guest access enabled' : 'Guest access paused'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-pf-deep/50">
                  <span className="font-mono">{venue.slug}</span>
                  <span>{venue._count.places} guide items</span>
                  <span>{formatGuideMode(venue.guideMode)}</span>
                  {venue.category ? <span>{venue.category}</span> : null}
                </div>
                <span className="text-sm font-semibold text-pf-primary">
                  Enter venue workspace <span aria-hidden="true">→</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4" aria-labelledby="tochi-rollout-heading">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Private rollout
          </p>
          <h2
            id="tochi-rollout-heading"
            className="mt-1 text-xl font-semibold tracking-tight text-pf-deep"
          >
            Tochi system access
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-pf-deep/60">
            A feature works only when both its server kill switch and this client allowlist are on.
            These controls are audited and do not publish a character pack by themselves.
          </p>
        </div>
        <AdminTochiRolloutForm tenantId={tenantId} flags={tochiRollout.flags} />
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <div className="rounded-2xl border border-pf-light bg-pf-white p-6">
          <h2 className="text-lg font-semibold tracking-tight text-pf-deep">Client access</h2>
          <p className="mt-1 text-sm text-pf-deep/55">
            People with an active role in this account.
          </p>
          <div className="mt-4">
            {tenant.memberships.length === 0 ? (
              <p className="text-sm text-pf-deep/60">No active members.</p>
            ) : (
              tenant.memberships.map((membership) => (
                <div
                  key={membership.id}
                  className="flex items-center justify-between gap-3 border-b border-pf-light px-1 py-3 last:border-0"
                >
                  <span className="text-sm text-pf-deep">
                    {membership.user.fullName ?? membership.user.email}
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wider text-pf-deep/50">
                    {membership.role}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <details className="rounded-2xl border border-pf-light bg-pf-white p-5" open>
            <summary className="cursor-pointer text-base font-semibold text-pf-deep">
              Account status
            </summary>
            <p className="mt-2 text-sm text-pf-deep/55">Current state: {tenant.status}</p>
            <div className="mt-4">
              <AdminClientStatusForm
                tenantId={tenant.id}
                currentStatus={tenant.status}
                expectedUpdatedAt={tenant.updatedAt.toISOString()}
              />
            </div>
          </details>
          <details className="rounded-2xl border border-pf-light bg-pf-white p-5">
            <summary className="cursor-pointer text-base font-semibold text-pf-deep">
              Plan & reporting
            </summary>
            <div className="mt-4 space-y-5">
              <AdminClientPlanForm
                tenantId={tenant.id}
                currentPlanTier={tenant.planTier}
                expectedUpdatedAt={tenant.updatedAt.toISOString()}
              />
              <div className="border-t border-pf-light pt-4">
                <p className="mb-3 text-sm text-pf-deep/55">
                  Queue this week&apos;s client digest manually.
                </p>
                <AdminTriggerDigestButton tenantId={tenant.id} />
              </div>
            </div>
          </details>
        </div>
      </section>

      <details className="rounded-2xl border border-pf-light bg-pf-white p-6">
        <summary className="cursor-pointer text-lg font-semibold tracking-tight text-pf-deep">
          Advanced: AI cost budget
        </summary>
        <div className="mt-5">
          <AdminAiCostBudgetForm
            tenantId={tenant.id}
            initialState={
              aiCostBudget.configured
                ? {
                    configured: true,
                    enabled: aiCostBudget.enabled,
                    startsAt: aiCostBudget.startsAt.toISOString(),
                    endsAt: aiCostBudget.endsAt.toISOString(),
                    hardLimitUsd: aiCostBudget.hardLimitUsd,
                    remainingUsd: aiCostBudget.remainingUsd,
                    reservedUsd: aiCostBudget.reservedUsd,
                    committedUsd: aiCostBudget.committedUsd,
                    revision: aiCostBudget.revision,
                    breachedAt: aiCostBudget.breachedAt?.toISOString() ?? null,
                    reason: aiCostBudget.reason,
                    updatedAt: aiCostBudget.updatedAt.toISOString(),
                    updatedBy: aiCostBudget.updatedBy,
                  }
                : {
                    configured: false,
                    enabled: false,
                    startsAt: null,
                    endsAt: null,
                    hardLimitUsd: '',
                    remainingUsd: '0.00000000',
                    reservedUsd: '0.00000000',
                    committedUsd: '0.00000000',
                    revision: null,
                    breachedAt: null,
                    reason: '',
                    updatedAt: null,
                    updatedBy: null,
                  }
            }
          />
        </div>
      </details>
    </div>
  )
}
