'use client'

import { ClientBillingPanel } from '../billing/ClientBillingPanel'
import { PortalNotice, PortalPage } from './PortalPrimitives'

export function BillingWorkspace({ enabled }: { enabled: boolean }) {
  return (
    <PortalPage
      title="Billing"
      description="Review your Stripe subscription, invoices, and payment details."
    >
      {enabled ? (
        <ClientBillingPanel />
      ) : (
        <PortalNotice>
          Billing details are not available for this organization. Contact Torchiko Support if you
          have a question about your arrangement.
        </PortalNotice>
      )}
    </PortalPage>
  )
}
