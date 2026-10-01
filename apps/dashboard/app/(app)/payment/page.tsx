import { BillingWorkspace } from '../../../components/portal/BillingWorkspace'
import { resolvePaymentAvailable } from '../../../lib/portal-capabilities'
import { createDashboardCaller } from '../../../lib/server-caller'

export const dynamic = 'force-dynamic'

export default async function PaymentPage() {
  const caller = await createDashboardCaller('/payment')
  const enabled = await resolvePaymentAvailable(caller)
  return <BillingWorkspace enabled={enabled} />
}
