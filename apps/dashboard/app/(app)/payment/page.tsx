import { CreditCard } from 'lucide-react'

import { ClientBillingPanel } from '../../../components/billing/ClientBillingPanel'

export const dynamic = 'force-dynamic'

export default function PaymentPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
      <header className="mb-6 flex items-start gap-3 sm:mb-8">
        <span className="rounded-2xl bg-pf-primary/10 p-3 text-pf-primary">
          <CreditCard className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">Account</p>
          <h1 className="mt-1 text-2xl font-semibold text-pf-deep sm:text-3xl">Payment</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/70">
            See your monthly price, payment status, paid-through date, and invoices in one place.
          </p>
        </div>
      </header>
      <ClientBillingPanel />
    </div>
  )
}
