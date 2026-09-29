import { redirect } from 'next/navigation'

// Payment now lives in Account; Stripe return URLs and older links still land here.
export default function PaymentPage() {
  redirect('/settings#payment')
}
