import Link from 'next/link'

export default function PaymentSuccessPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-sky-200 bg-white p-8 text-center shadow-sm">
        <span
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-xl text-sky-900"
          aria-hidden="true"
        >
          …
        </span>
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Subscription Checkout
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-pf-deep">Payment is being confirmed</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-pf-deep/70">
          Returning from Stripe does not activate access by itself. This page updates after a
          verified webhook or reconciliation confirms the subscription.
        </p>
        <Link
          href="/payment"
          className="mt-7 inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
        >
          View payment status
        </Link>
      </section>
    </div>
  )
}
