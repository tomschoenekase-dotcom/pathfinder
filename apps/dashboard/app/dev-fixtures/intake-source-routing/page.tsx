import { notFound } from 'next/navigation'
import { IntakeSourceRoutingControl } from '../../../components/admin/IntakeSourceRoutingControl'
import { TRPCProvider } from '../../../lib/trpc'
export default function SourceRoutingFixture() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  return (
    <TRPCProvider scopeKey="fixture-intake-source-routing">
      <main className="mx-auto max-w-5xl space-y-6 px-5 py-10 text-pf-deep">
        <h1 className="text-3xl font-semibold">Source review routing</h1>
        <p>Local fixture for the operator control.</p>
        <h2 className="sr-only">Review controls</h2>
        <IntakeSourceRoutingControl
          tenantId="fixture-routing-tenant"
          venueId="fixture-routing-venue"
          identities={[]}
        />
      </main>
    </TRPCProvider>
  )
}
