import { AccountWorkspace } from '../../../components/portal/AccountWorkspace'
import { resolveWeeklyReportsAvailable } from '../../../lib/portal-capabilities'
import { createDashboardCaller } from '../../../lib/server-caller'

export const dynamic = 'force-dynamic'

export default async function AccountPage() {
  const caller = await createDashboardCaller('/settings')
  const reportsAvailable = await resolveWeeklyReportsAvailable(caller)
  return <AccountWorkspace reportsAvailable={reportsAvailable} />
}
