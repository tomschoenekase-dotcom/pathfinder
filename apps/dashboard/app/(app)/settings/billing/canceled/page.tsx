import Link from 'next/link'

export default function BillingCheckoutCanceledPage() {
  return (
    <main className="min-h-screen bg-pf-surface px-6 py-16">
      <section className="mx-auto max-w-2xl rounded-3xl border border-pf-light bg-white p-8 text-center shadow-sm">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Subscription Checkout
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-pf-deep">Checkout was not completed</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-pf-deep/70">
          No access change was made from this browser redirect. Return to billing to retry safely or
          contact Torchiko about negotiated terms.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link
            href="/settings"
            className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white hover:bg-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
          >
            Return to billing
          </Link>
          <Link
            href="/support"
            className="inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-semibold text-pf-deep hover:bg-pf-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            Contact support
          </Link>
        </div>
      </section>
    </main>
  )
}
