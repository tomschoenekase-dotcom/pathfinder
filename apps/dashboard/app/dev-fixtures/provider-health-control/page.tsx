import { AiProviderHealthControl } from '../../../components/admin/AiProviderHealthControl'
import { TRPCProvider } from '../../../lib/trpc'

export default function ProviderHealthControlFixturePage() {
  return (
    <TRPCProvider scopeKey="provider-health-control-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-pf-deep/60">
            Founder Control Room fixture · provider-dark
          </p>
          <AiProviderHealthControl
            initialState={{
              overrides: [
                {
                  provider: 'anthropic',
                  reason: 'Synthetic route incident under review',
                  expiresAt: '2099-08-23T20:00:00.000Z',
                  active: true,
                },
                {
                  provider: 'openai',
                  reason: 'Synthetic recovered embedding incident',
                  expiresAt: '2026-08-22T18:00:00.000Z',
                  active: false,
                },
              ],
              activeUnhealthyProviders: ['anthropic'],
              configured: true,
              malformed: false,
              updatedAt: '2026-08-22T20:00:00.000Z',
              updatedBy: 'fixture-admin',
            }}
          />
        </div>
      </main>
    </TRPCProvider>
  )
}
