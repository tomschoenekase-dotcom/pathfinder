'use client'

import { ClientBillingPanel } from '../billing/ClientBillingPanel'
import { PortalNotice, PortalPage } from './PortalPrimitives'

/** `enabled` exists only for design fixtures; the live page always renders the billing panel. */
export function BillingWorkspace({ enabled = true }: { enabled?: boolean }) {
  return (
    <PortalPage
      title="Billing"
      description="See what you pay Torchiko, what is due, and what to do next."
    >
      {enabled ? (
        <ClientBillingPanel />
      ) : (
        <PortalNotice>
          Billing is not shown for this organization. Contact Torchiko Support if you have a
          question about your arrangement.
        </PortalNotice>
      )}
    </PortalPage>
  )
}
