import { BillingWorkspace } from '../../../components/portal/BillingWorkspace'

export const dynamic = 'force-dynamic'

/**
 * The page itself performs no billing read. The client panel asks `billing.clientState`, which
 * enforces the role and tenant on the server and always yields an explicit state (including
 * loading, forbidden and error), so a billing failure can never blank or mislabel this page.
 */
export default function PaymentPage() {
  return <BillingWorkspace />
}
