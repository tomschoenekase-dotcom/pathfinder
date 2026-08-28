import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, CreditCard, RefreshCw } from 'lucide-react'

type Portfolio = {
  summary: { customers: number; attention: number; pastDue: number; unhealthy: number }
  bounded: boolean
  rows: Array<{
    id: string
    tenantId: string
    displayNameSnapshot: string
    billingEmail: string | null
    billingMode: string
    currency: string
    status: string
    paidThroughAt: Date | null
    gracePeriodEndsAt: Date | null
    reconciliationHealth: string
    lastReconciledAt: Date | null
    updatedAt: Date
    tenant: { id: string; name: string; status: string }
    crmOrganization: { id: string; canonicalName: string } | null
    needsAttention: boolean
    paymentRecovery: {
      state: string
      reviewRequired: boolean
      policy: {
        relationshipPreserving: true
        automaticRestrictionAuthorized: false
        automaticCustomerContactAuthorized: false
        graceAndCutoffPolicy: 'UNRESOLVED'
      }
      timing: {
        delinquentSince: Date | null
        daysDelinquent: number | null
        nextRetryAt: Date | null
        gracePeriodEndsAt: Date | null
        graceState: string
      }
      financialExposure: {
        receivableAtRiskByCurrency: Array<{ currency: string; amountMinor: bigint }>
        ongoingVariableCost: null | {
          amountMinor: bigint
          currency: string
          asOf: Date | null
        }
        complete: boolean
      }
      relationship: null | {
        organizationId: string
        organizationName: string
        relationshipTier: string | null
        relationshipStartedAt: Date
      }
      missingEvidence: string[]
      recommendedNextStep: string
    }
    customerRequests?: Array<{
      id: string
      kind: string
      status: string
      featureLabelSnapshot: string | null
      reason: string | null
      createdAt: Date
    }>
    agreement: null | {
      id: string
      internalPlanKey: string
      status: string
      billingMode: string
      billingInterval: string
      agreedAmountMinor: bigint | null
      currency: string
      currentPeriodEndsAt: Date | null
      cancelAtPeriodEnd: boolean
      coveredVenueCount: number
    }
    latestInvoices: Array<{
      id: string
      status: string
      amountDueMinor: bigint
      amountPaidMinor: bigint
      currency: string
      dueAt: Date | null
      paidAt: Date | null
      failedAt: Date | null
      failureSummary: string | null
    }>
  }>
}

function money(amount: bigint | null, currency: string) {
  if (amount === null) return 'Negotiated amount not recorded'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(Number(amount) / 100)
}

function date(value: Date | null) {
  return value
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
        value,
      )
    : 'Not recorded'
}

function label(value: string) {
  return value.replaceAll('_', ' ').toLowerCase()
}

function RecoveryBrief({ recovery }: { recovery: Portfolio['rows'][number]['paymentRecovery'] }) {
  if (!recovery.reviewRequired) {
    return <p className="text-xs font-semibold text-emerald-700">No payment recovery indicated</p>
  }
  return (
    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
      <p className="font-bold">Relationship-preserving review</p>
      <dl className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        <div>
          <dt className="text-amber-800">Time delinquent</dt>
          <dd className="font-semibold">
            {recovery.timing.daysDelinquent === null
              ? 'Not established'
              : `${recovery.timing.daysDelinquent} day${recovery.timing.daysDelinquent === 1 ? '' : 's'}`}
          </dd>
        </div>
        <div>
          <dt className="text-amber-800">Receivable at risk</dt>
          <dd className="font-semibold">
            {recovery.financialExposure.receivableAtRiskByCurrency.length
              ? recovery.financialExposure.receivableAtRiskByCurrency
                  .map((entry) => money(entry.amountMinor, entry.currency))
                  .join(' + ')
              : 'Not established'}
          </dd>
        </div>
        <div>
          <dt className="text-amber-800">Relationship</dt>
          <dd className="font-semibold">
            {recovery.relationship?.relationshipTier
              ? label(recovery.relationship.relationshipTier)
              : (recovery.relationship?.organizationName ?? 'Not recorded')}
          </dd>
        </div>
        <div>
          <dt className="text-amber-800">Next provider retry</dt>
          <dd className="font-semibold">{date(recovery.timing.nextRetryAt)}</dd>
        </div>
      </dl>
      {recovery.missingEvidence.length ? (
        <p className="mt-2 text-amber-800">
          Missing context: {recovery.missingEvidence.map(label).join(', ')}
        </p>
      ) : null}
      <p className="mt-2 font-semibold">No automatic cutoff or customer contact is authorized.</p>
    </div>
  )
}

export function AdminBillingPortfolio({
  data,
  search = '',
  attentionOnly = false,
}: {
  data: Portfolio
  search?: string
  attentionOnly?: boolean
}) {
  const stats: Array<{ term: string; value: number; icon: LucideIcon; tone: string }> = [
    {
      term: 'Customers',
      value: data.summary.customers,
      icon: CreditCard,
      tone: 'text-sky-700 bg-sky-50',
    },
    {
      term: 'Needs attention',
      value: data.summary.attention,
      icon: AlertTriangle,
      tone: 'text-amber-700 bg-amber-50',
    },
    {
      term: 'Past due',
      value: data.summary.pastDue,
      icon: AlertTriangle,
      tone: 'text-rose-700 bg-rose-50',
    },
    {
      term: 'Reconciliation warnings',
      value: data.summary.unhealthy,
      icon: RefreshCw,
      tone: 'text-violet-700 bg-violet-50',
    },
  ]
  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-700">
            Revenue operations
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">
            Billing portfolio
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Customer agreements, paid-through dates, invoice health, recovery signals, and CRM
            links. Stripe remains the processor; Torchiko&apos;s durable billing projection is shown
            here.
          </p>
        </div>
        <form method="get" className="flex w-full flex-col gap-2 sm:flex-row lg:max-w-xl">
          <label className="sr-only" htmlFor="billing-search">
            Search billing customers
          </label>
          <input
            id="billing-search"
            name="search"
            defaultValue={search}
            placeholder="Search client or billing email"
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm"
          />
          <label className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700">
            <input type="checkbox" name="attention" value="1" defaultChecked={attentionOnly} />
            Needs attention
          </label>
          <button className="min-h-11 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white">
            Filter
          </button>
        </form>
      </header>

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Billing portfolio summary"
      >
        {stats.map(({ term, value, icon: Icon, tone }) => (
          <article
            key={term}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <span className={`inline-flex rounded-xl p-2 ${tone}`}>
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="mt-3 text-xs font-bold uppercase tracking-wider text-slate-400">{term}</p>
            <p className="mt-1 text-2xl font-bold text-slate-950">{value}</p>
          </article>
        ))}
      </section>

      {data.rows.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-600" aria-hidden="true" />
          <h2 className="mt-3 font-semibold text-slate-950">No matching billing accounts</h2>
          <p className="mt-1 text-sm text-slate-500">
            No customer payment state matches this view.
          </p>
        </section>
      ) : (
        <>
          <section className="grid gap-4 lg:hidden" aria-label="Billing customer cards">
            {data.rows.map((row) => {
              const invoice = row.latestInvoices[0] ?? null
              return (
                <article
                  key={row.id}
                  className={`rounded-2xl border bg-white p-5 shadow-sm ${
                    row.needsAttention ? 'border-amber-300' : 'border-slate-200'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <Link
                        href={`/admin/clients/${row.tenantId}/billing`}
                        className="font-semibold text-sky-800 hover:underline"
                      >
                        {row.tenant.name}{' '}
                        <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                      <p className="mt-1 text-xs text-slate-500">
                        {row.billingEmail ?? 'No billing email recorded'}
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      {label(row.status)}
                    </span>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-slate-500">Agreement</dt>
                      <dd className="font-semibold text-slate-950">
                        {money(
                          row.agreement?.agreedAmountMinor ?? null,
                          row.agreement?.currency ?? row.currency,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Latest invoice</dt>
                      <dd className="font-semibold text-slate-950">
                        {invoice ? money(invoice.amountDueMinor, invoice.currency) : 'No invoice'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Paid through</dt>
                      <dd className="font-semibold text-slate-950">
                        {date(row.paidThroughAt ?? row.agreement?.currentPeriodEndsAt ?? null)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Reconciliation</dt>
                      <dd className="font-semibold text-slate-950">
                        {label(row.reconciliationHealth)}
                      </dd>
                    </div>
                  </dl>
                  <RecoveryBrief recovery={row.paymentRecovery} />
                  {row.crmOrganization ? (
                    <Link
                      href={`/admin/prospects/${row.crmOrganization.id}`}
                      className="mt-4 inline-flex min-h-11 items-center text-xs font-semibold text-violet-700 hover:underline"
                    >
                      CRM: {row.crmOrganization.canonicalName}
                    </Link>
                  ) : null}
                </article>
              )
            })}
          </section>
          <section className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[72rem] text-left text-sm">
                <caption className="sr-only">Customer billing portfolio</caption>
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th scope="col" className="px-5 py-3">
                      Customer
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Agreement
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Billing status
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Paid through
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Latest invoice
                    </th>
                    <th scope="col" className="px-5 py-3">
                      Health
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((row) => {
                    const invoice = row.latestInvoices[0] ?? null
                    return (
                      <tr
                        key={row.id}
                        className={row.needsAttention ? 'bg-amber-50/35' : undefined}
                      >
                        <td className="px-5 py-4 align-top">
                          <Link
                            href={`/admin/clients/${row.tenantId}/billing`}
                            className="font-semibold text-sky-800 hover:underline"
                          >
                            {row.tenant.name}{' '}
                            <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden="true" />
                          </Link>
                          <p className="mt-1 text-xs text-slate-500">
                            {row.billingEmail ?? 'No billing email recorded'}
                          </p>
                          {row.crmOrganization ? (
                            <Link
                              href={`/admin/prospects/${row.crmOrganization.id}`}
                              className="mt-2 inline-flex text-xs font-semibold text-violet-700 hover:underline"
                            >
                              CRM: {row.crmOrganization.canonicalName}
                            </Link>
                          ) : (
                            <p className="mt-2 text-xs text-slate-400">No CRM relationship link</p>
                          )}
                        </td>
                        <td className="px-5 py-4 align-top">
                          <p className="font-semibold text-slate-900">
                            {money(
                              row.agreement?.agreedAmountMinor ?? null,
                              row.agreement?.currency ?? row.currency,
                            )}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {row.agreement
                              ? `${label(row.agreement.billingInterval)} · ${row.agreement.coveredVenueCount} venue${row.agreement.coveredVenueCount === 1 ? '' : 's'}`
                              : 'No agreement'}
                          </p>
                        </td>
                        <td className="px-5 py-4 align-top">
                          <span className="font-semibold text-slate-900">{label(row.status)}</span>
                          <p className="mt-1 text-xs text-slate-500">{label(row.billingMode)}</p>
                          {row.customerRequests?.length ? (
                            <p className="mt-2 text-xs font-semibold text-amber-800">
                              {row.customerRequests.length} open customer request
                              {row.customerRequests.length === 1 ? '' : 's'}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-5 py-4 align-top">
                          <span className="font-medium text-slate-900">
                            {date(row.paidThroughAt ?? row.agreement?.currentPeriodEndsAt ?? null)}
                          </span>
                          {row.gracePeriodEndsAt ? (
                            <p className="mt-1 text-xs font-semibold text-amber-700">
                              Grace ends {date(row.gracePeriodEndsAt)}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-5 py-4 align-top">
                          {invoice ? (
                            <>
                              <span className="font-semibold text-slate-900">
                                {money(invoice.amountDueMinor, invoice.currency)}
                              </span>
                              <p className="mt-1 text-xs text-slate-500">
                                {label(invoice.status)} · {date(invoice.paidAt ?? invoice.dueAt)}
                              </p>
                              {invoice.failureSummary ? (
                                <p className="mt-1 max-w-xs text-xs text-rose-700">
                                  {invoice.failureSummary}
                                </p>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-slate-400">No invoice</span>
                          )}
                        </td>
                        <td className="px-5 py-4 align-top">
                          <span
                            className={
                              row.needsAttention
                                ? 'font-semibold text-amber-800'
                                : 'font-semibold text-emerald-700'
                            }
                          >
                            {label(row.reconciliationHealth)}
                          </span>
                          <p className="mt-1 text-xs text-slate-500">
                            Checked {date(row.lastReconciledAt)}
                          </p>
                          <RecoveryBrief recovery={row.paymentRecovery} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {data.bounded ? (
        <p className="text-xs text-slate-500">
          This view is bounded to the newest matching billing accounts. Refine the search for a
          specific customer.
        </p>
      ) : null}
    </div>
  )
}
