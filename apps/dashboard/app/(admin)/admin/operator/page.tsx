import { notFound } from 'next/navigation'

import { createAdminCaller } from '../../../../lib/admin-caller'
import { resolveOperatorSession } from '../../../../lib/operator-session'
import { OperatorAdminView } from '../../../../components/operator/OperatorAdminView'
import { OPERATOR_TABS, type OperatorTabId } from '../../../../components/operator/operator-tabs'
import { OperatorAudit, AUDIT_EVENT_TYPES } from '../../../../components/operator/OperatorAudit'
import { OperatorAutonomy } from '../../../../components/operator/OperatorAutonomy'
import { OperatorConnections } from '../../../../components/operator/OperatorConnections'
import { OperatorInbox } from '../../../../components/operator/OperatorInbox'
import { OperatorPanelError } from '../../../../components/operator/OperatorPanelError'
import { loadOperatorPanel } from '../../../../lib/operator-panel'

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

  // Each tab reads exactly one source. A failed read becomes an honest error panel inside the
  // page frame (tabs stay usable), never an empty list; the global error boundary is reserved for
  // failures outside these reads (session, caller construction, rendering).
  const retryHref = `/admin/operator?tab=${tab}`

  if (tab === 'autonomy') {
    const result = await loadOperatorPanel('autonomy', () => caller.admin.operatorAutonomy())
    if (!result.ok) {
      return (
        <OperatorAdminView tab={tab} inboxCount={null}>
          <OperatorPanelError section="Autonomy" category={result.category} retryHref={retryHref} />
        </OperatorAdminView>
      )
    }
    const rows = result.data
    return (
      <OperatorAdminView tab={tab} inboxCount={null}>
        <OperatorAutonomy rows={rows} />
      </OperatorAdminView>
    )
  }
  if (tab === 'connections') {
    const result = await loadOperatorPanel('connections', () => caller.admin.operatorConnections())
    if (!result.ok) {
      return (
        <OperatorAdminView tab={tab} inboxCount={null}>
          <OperatorPanelError
            section="Connections"
            category={result.category}
            retryHref={retryHref}
          />
        </OperatorAdminView>
      )
    }
    const rows = result.data
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
    const result = await loadOperatorPanel('audit', () =>
      caller.admin.operatorAudit({
        ...(eventType ? { eventType } : {}),
        ...(outcome ? { outcome } : {}),
        ...(tool ? { tool } : {}),
        ...(days ? { days: days as 1 | 7 | 30 | 90 } : {}),
      }),
    )
    if (!result.ok) {
      return (
        <OperatorAdminView tab={tab} inboxCount={null}>
          <OperatorPanelError section="Audit" category={result.category} retryHref={retryHref} />
        </OperatorAdminView>
      )
    }
    const rows = result.data
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
  const inbox = await loadOperatorPanel('inbox', () => caller.admin.operatorInbox())
  if (!inbox.ok) {
    return (
      <OperatorAdminView tab="inbox" inboxCount={null}>
        <OperatorPanelError
          section="Inbox"
          category={inbox.category}
          retryHref="/admin/operator?tab=inbox"
        />
      </OperatorAdminView>
    )
  }
  const items = inbox.data
  return (
    <OperatorAdminView tab="inbox" inboxCount={items.length}>
      <OperatorInbox items={items} now={now} />
    </OperatorAdminView>
  )
}
