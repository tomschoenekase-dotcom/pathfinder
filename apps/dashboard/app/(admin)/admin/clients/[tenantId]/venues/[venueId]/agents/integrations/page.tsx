export const dynamic = 'force-dynamic'

import { env } from '@pathfinder/config'

import { AgentIntegrationsView } from '../../../../../../../../../components/admin/AgentIntegrationsView'
import { createAdminCaller } from '../../../../../../../../../lib/admin-caller'

export default async function AgentIntegrationsPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
}) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()
  const [sessions, identities] = await Promise.all([
    caller.admin.listAgentBridgeSessions({ tenantId, venueId }),
    caller.admin.listAgentIdentities({ tenantId, venueId, limit: 100 }),
  ])
  return (
    <AgentIntegrationsView
      tenantId={tenantId}
      venueId={venueId}
      sessions={sessions}
      identities={identities.items}
      agentRunnerEnabled={env.AGENT_RUNNER_ENABLED}
      bridgeHttpEnabled={env.AGENT_BRIDGE_HTTP_ENABLED}
    />
  )
}
