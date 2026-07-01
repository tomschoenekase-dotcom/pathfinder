export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { AdminClientPlanForm } from '../../../../../components/admin/AdminClientPlanForm'
import { AdminClientStatusForm } from '../../../../../components/admin/AdminClientStatusForm'
import { AdminTriggerDigestButton } from '../../../../../components/admin/AdminTriggerDigestButton'
import { ViewAsClientButton } from '../../../../../components/admin/ViewAsClientButton'
import { createAdminCaller } from '../../../../../lib/admin-caller'
import { getStatusClasses } from '../../../../../lib/admin-status'

type AdminClientDetailPageProps = {
  params: Promise<{ tenantId: string }>
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-widest text-pf-deep/40">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">{value}</p>
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
      <div className="space-y-6">
        <Link href="/admin" className="text-sm font-medium text-pf-primary hover:text-pf-accent">
          ← Back to overview
        </Link>
        <div className="rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-pf-deep">Client not found</h1>
          <p className="mt-2 text-sm text-pf-deep/60">This tenant record does not exist.</p>
        </div>
      </div>
    )
  }

  const { tenant, venues, engagement7d } = data
  const placesTotal = venues.reduce((total, venue) => total + venue._count.places, 0)

  return (
    <div className="space-y-10">
      <Link href="/admin" className="text-sm font-medium text-pf-primary hover:text-pf-accent">
        ← Back to overview
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">{tenant.name}</h1>
            <span
              className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${getStatusClasses(tenant.status)}`}
            >
              {tenant.status}
            </span>
          </div>
          <ViewAsClientButton tenantId={tenant.id} tenantName={tenant.name} />
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-pf-deep/50">
          <span className="rounded-full bg-pf-surface px-2 py-0.5 font-mono">{tenant.slug}</span>
          <span>Plan: {tenant.planTier}</span>
          <span>Created {tenant.createdAt.toLocaleDateString()}</span>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Venues" value={venues.length} />
        <StatCard label="Points of interest" value={placesTotal} />
        <StatCard label="Sessions (7d)" value={engagement7d.sessions} />
        <StatCard label="Messages (7d)" value={engagement7d.messages} />
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Venues</h2>
        {venues.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60 shadow-sm">
            This client has no venues yet.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {venues.map((venue) => (
              <Link
                key={venue.id}
                href={`/admin/clients/${tenantId}/venues/${venue.id}`}
                className="flex flex-col gap-3 rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm transition hover:border-pf-accent"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold tracking-tight text-pf-deep">
                    {venue.name}
                  </h3>
                  {venue.isActive ? null : (
                    <span className="inline-flex rounded-full border border-pf-light bg-pf-surface px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-pf-deep/50">
                      Inactive
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-pf-deep/50">
                  <span className="rounded-full bg-pf-surface px-2 py-0.5 font-mono">
                    {venue.slug}
                  </span>
                  <span>{venue._count.places} POIs</span>
                  <span>{formatGuideMode(venue.guideMode)}</span>
                  {venue.category ? <span>{venue.category}</span> : null}
                </div>
                <span className="text-sm font-medium text-pf-primary">View venue →</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold tracking-tight text-pf-deep">Members</h2>
          <div className="mt-4 space-y-2">
            {tenant.memberships.length === 0 ? (
              <p className="text-sm text-pf-deep/60">No active members.</p>
            ) : (
              tenant.memberships.map((membership) => (
                <div
                  key={membership.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-pf-light bg-pf-surface px-4 py-3"
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

        <div className="space-y-6">
          <div className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold tracking-tight text-pf-deep">Status</h2>
            <p className="mt-1 text-sm text-pf-deep/60">Current: {tenant.status}</p>
            <div className="mt-4">
              <AdminClientStatusForm tenantId={tenant.id} currentStatus={tenant.status} />
            </div>
          </div>

          <div className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold tracking-tight text-pf-deep">Plan</h2>
            <p className="mt-1 text-sm text-pf-deep/60">Current: {tenant.planTier}</p>
            <div className="mt-4">
              <AdminClientPlanForm tenantId={tenant.id} currentPlanTier={tenant.planTier} />
            </div>
          </div>

          <div className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold tracking-tight text-pf-deep">Weekly digest</h2>
            <p className="mt-1 text-sm text-pf-deep/60">
              Queue this week’s digest job manually for this client.
            </p>
            <div className="mt-4">
              <AdminTriggerDigestButton tenantId={tenant.id} />
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
