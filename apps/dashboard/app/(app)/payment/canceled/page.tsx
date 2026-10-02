import Link from 'next/link'

export default function PaymentCanceledPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-pf-light bg-white p-8 text-center shadow-sm">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Subscription Checkout
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-pf-deep">Checkout was not completed</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-pf-deep/70">
          No billing or access change was made. You can retry safely or contact Torchiko about your
          agreed monthly price.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link
            href="/payment"
            className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
          >
            Return to payment
          </Link>
          <Link
            href="/support"
            className="inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-semibold text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            Contact support
          </Link>
        </div>
      </section>
    </div>
  )
}
