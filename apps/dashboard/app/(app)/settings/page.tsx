import { AccountWorkspace } from '../../../components/portal/AccountWorkspace'
import {
  resolvePaymentAvailable,
  resolveWeeklyReportsAvailable,
} from '../../../lib/portal-capabilities'
import { createDashboardCaller } from '../../../lib/server-caller'

export const dynamic = 'force-dynamic'

export default async function AccountPage() {
  const caller = await createDashboardCaller('/settings')
  const [paymentAvailable, reportsAvailable] = await Promise.all([
    resolvePaymentAvailable(caller),
    resolveWeeklyReportsAvailable(caller),
  ])
  return (
    <AccountWorkspace paymentAvailable={paymentAvailable} reportsAvailable={reportsAvailable} />
  )
}
