import { notFound } from 'next/navigation'

import { AdminSectionShell } from '../../../components/admin/AdminSectionShell'
import { ClientWorkspaceShell } from '../../../components/admin/ClientWorkspaceShell'
import { TRPCProvider } from '../../../lib/trpc'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Torchiko authenticated operations browser fixture' }

type Props = { searchParams: Promise<{ surface?: string }> }

function AdminFixture() {
  return (
    <TRPCProvider scopeKey="authenticated-admin-visual-fixture">
      <AdminSectionShell routePathname="/admin/operations">
        <div data-fixture="authenticated-operations" data-fixture-surface="admin">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
            Deterministic Founder Control Room fixture
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
                Founder Control Room
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Synthetic operational evidence only. This fixture cannot approve work, contact a
                customer, or mutate company state.
              </p>
            </div>
            <span className="w-fit rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
              Local evidence current
            </span>
          </div>

          <section className="mt-7 grid gap-4 md:grid-cols-3" aria-label="Founder briefing">
            {[
              ['Needs your decision', '2', 'Pricing and production release remain founder-gated.'],
              ['Agents waiting', '1', 'One synthetic workflow is paused for an approval.'],
              ['Customer impact', 'None', 'No customer-facing incident is represented here.'],
            ].map(([label, value, detail]) => (
              <article
                key={label}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {label}
                </p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
                <p className="mt-2 text-sm leading-5 text-slate-600">{detail}</p>
              </article>
            ))}
          </section>

          <section
            className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-5"
            aria-labelledby="fixture-decision"
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-amber-800">
              Compact decision
            </p>
            <h2 id="fixture-decision" className="mt-2 text-lg font-semibold text-amber-950">
              Staging release awaits owner awareness
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-900">
              The candidate is locally verified. This visual fixture records no approval and exposes
              no production action.
            </p>
          </section>
        </div>
      </AdminSectionShell>
    </TRPCProvider>
  )
}

function WorkspaceFixture() {
  return (
    <main
      className="min-h-screen bg-pf-cream p-3 text-pf-deep sm:p-6"
      data-fixture="authenticated-operations"
      data-fixture-surface="workspace"
    >
      <ClientWorkspaceShell
        routePathname="/admin/clients/fixture-client/venues/fixture-venue/content"
        billingAvailable
        client={{
          id: 'fixture-client',
          name: 'Great Lakes Museum Group',
          slug: 'great-lakes-museum-group',
          status: 'ACTIVE',
        }}
        venues={[
          {
            id: 'fixture-venue',
            name: 'Harbor Discovery Museum',
            slug: 'harbor-discovery-museum',
            isActive: true,
            guestUrl: 'https://example.invalid/harbor-discovery-museum',
          },
          {
            id: 'fixture-venue-2',
            name: 'Lakeside Science Annex',
            slug: 'lakeside-science-annex',
            isActive: false,
            guestUrl: null,
          },
        ]}
      >
        <section aria-labelledby="workspace-fixture-title">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
            Synthetic venue content state
          </p>
          <h2 id="workspace-fixture-title" className="mt-2 text-2xl font-semibold tracking-tight">
            Universal content
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/75">
            Venue-scoped content and provenance remain separate from the organization-wide record.
            No customer data is read or changed by this fixture.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <article className="rounded-2xl border border-pf-light bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">
                Current truth
              </p>
              <p className="mt-2 font-semibold">Accessible entrance: Harbor Street</p>
              <p className="mt-1 text-sm text-pf-deep/70">Verified synthetic source · August 24</p>
            </article>
            <article className="rounded-2xl border border-pf-light bg-white p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/75">
                Historical truth
              </p>
              <p className="mt-2 font-semibold">Old east-door directions retained</p>
              <p className="mt-1 text-sm text-pf-deep/70">
                Superseded and excluded from guest answers
              </p>
            </article>
          </div>
        </section>
      </ClientWorkspaceShell>
    </main>
  )
}

export default async function AuthenticatedOperationsFixturePage({ searchParams }: Props) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const surface = (await searchParams).surface
  return surface === 'workspace' ? <WorkspaceFixture /> : <AdminFixture />
}
