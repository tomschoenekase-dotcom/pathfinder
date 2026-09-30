import { notFound } from 'next/navigation'

import { createAdminCaller } from '../../../../lib/admin-caller'
import { resolveOperatorSession } from '../../../../lib/operator-session'
import {
  OperatorAdminView,
  OPERATOR_TABS,
  type OperatorTabId,
} from '../../../../components/operator/OperatorAdminView'
import { OperatorAudit, AUDIT_EVENT_TYPES } from '../../../../components/operator/OperatorAudit'
import { OperatorAutonomy } from '../../../../components/operator/OperatorAutonomy'
import { OperatorConnections } from '../../../../components/operator/OperatorConnections'
import { OperatorInbox } from '../../../../components/operator/OperatorInbox'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

function parseTab(value: string): OperatorTabId {
  return OPERATOR_TABS.find((tab) => tab.id === value)?.id ?? 'inbox'
}

/** Platform admin only, and absent (404) unless the operator is enabled and fully configured. */
export default async function OperatorAdminPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const session = await resolveOperatorSession()
  if (session.status === 'disabled' || session.status === 'misconfigured') notFound()
  if (session.status === 'forbidden') {
    return (
      <div>
        <h1 className="text-2xl font-semibold text-slate-950">Not allowed</h1>
        <p className="mt-1 text-sm text-slate-700">
          This account is not on the operator allowlist.
        </p>
      </div>
    )
  }
  const query = await searchParams
  const tab = parseTab(first(query.tab))
  const caller = await createAdminCaller()
  const now = new Date()

  if (tab === 'autonomy') {
    const rows = await caller.admin.operatorAutonomy()
    return (
      <OperatorAdminView tab={tab} inboxCount={null}>
        <OperatorAutonomy rows={rows} />
      </OperatorAdminView>
    )
  }
  if (tab === 'connections') {
    const rows = await caller.admin.operatorConnections()
    return (
      <OperatorAdminView tab={tab} inboxCount={null}>
        <OperatorConnections rows={rows} now={now} />
      </OperatorAdminView>
    )
  }
  if (tab === 'audit') {
    const eventType = AUDIT_EVENT_TYPES.find((type) => type === first(query.eventType))
    const outcome = first(query.outcome).slice(0, 64)
    const tool = first(query.tool).slice(0, 120)
    const days = [1, 7, 30, 90].find((value) => String(value) === first(query.days))
    const rows = await caller.admin.operatorAudit({
      ...(eventType ? { eventType } : {}),
      ...(outcome ? { outcome } : {}),
      ...(tool ? { tool } : {}),
      ...(days ? { days: days as 1 | 7 | 30 | 90 } : {}),
    })
    return (
      <OperatorAdminView tab={tab} inboxCount={null}>
        <OperatorAudit
          rows={rows}
          filters={{
            eventType: eventType ?? '',
            outcome,
            tool,
            days: days ? String(days) : '',
          }}
        />
      </OperatorAdminView>
    )
  }
  const items = await caller.admin.operatorInbox()
  return (
    <OperatorAdminView tab="inbox" inboxCount={items.length}>
      <OperatorInbox items={items} now={now} />
    </OperatorAdminView>
  )
}
