import { isFeatureEnabled } from '@pathfinder/config'
import {
  buildGuestKnowledgePolicy,
  type GuestKnowledgePolicy,
} from '@pathfinder/contracts/live-data'

import {
  resolveGuestGeneralWebConfiguration,
  type GuestGeneralWebConfigurationClient,
} from './guest-general-web-configuration'

export type GuestKnowledgePolicyClient = GuestGeneralWebConfigurationClient & {
  liveDataConnector: {
    count(args: { where: { tenantId: string; venueId: string; state?: 'ACTIVE' } }): Promise<number>
  }
}

/**
 * Server-side, per-venue, read-only view of what the guest guide may use beyond approved venue
 * content. There is deliberately no input that can turn open-web browsing on: `openWeb` is a
 * constant, so message text, query parameters, venue documents and tenant flags cannot change it.
 * The allowlisted general-background fallback is reported (never widened) as general knowledge.
 */
export async function resolveGuestKnowledgePolicy(
  client: GuestKnowledgePolicyClient,
  input: { tenantId: string; venueId: string },
): Promise<GuestKnowledgePolicy> {
  const generalWeb = await resolveGuestGeneralWebConfiguration(
    {
      tenantId: input.tenantId,
      venueId: input.venueId,
      globalEnabled: isFeatureEnabled('guestGeneralWebFallback'),
    },
    client,
  )
  const [totalConnectorCount, activeConnectorCount] = await Promise.all([
    client.liveDataConnector.count({
      where: { tenantId: input.tenantId, venueId: input.venueId },
    }),
    client.liveDataConnector.count({
      where: { tenantId: input.tenantId, venueId: input.venueId, state: 'ACTIVE' },
    }),
  ])
  return buildGuestKnowledgePolicy({
    generalBackgroundAllowedDomains: generalWeb ? [...generalWeb.allowedDomains] : [],
    activeConnectorCount,
    totalConnectorCount,
  })
}
