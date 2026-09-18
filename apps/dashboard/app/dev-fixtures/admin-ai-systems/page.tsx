import { AdminAiSystemsView } from '../../../components/admin/AdminAiSystemsView'
import { AdminSectionShell } from '../../../components/admin/AdminSectionShell'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Torchiko AI systems browser fixture' }

export default function AdminAiSystemsFixture() {
  const systems = {
    customerChat: {
      workloadId: 'guest-chat',
      effective: {
        primaryModelKey: 'guest-chat',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        source: 'PLATFORM',
      },
      workloadOverride: null,
      modelOptions: [
        {
          key: 'guest-chat',
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          costTier: 'ECONOMY',
          available: true,
        },
        {
          key: 'guest-chat-openai',
          provider: 'openai',
          model: 'gpt-5-mini-2025-08-07',
          costTier: 'ECONOMY',
          available: false,
        },
      ],
      providerKeyAvailability: { anthropic: true, openai: false },
      scopedExceptionCount: 2,
    },
    limitations: {
      providerExecution: false,
      deepSeek: false,
      openRouter: false,
      priceTierRouting: false,
    },
  }
  const credentials = [
    {
      id: 'fixture-operator',
      workerId: 'hermes-main-01',
      label: 'Hermes operator policy',
      capabilities: ['founder-operating-view:read'],
      secretPrefix: 'pf_platform_fixture',
      hashAlgorithm: 'sha256',
      enabled: true,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: new Date('2026-09-17T21:00:00.000Z'),
      createdBy: 'fixture-admin',
      activatedBy: 'fixture-admin',
      activatedAt: new Date('2026-09-17T20:00:00.000Z'),
      createdAt: new Date('2026-09-17T20:00:00.000Z'),
      updatedAt: new Date('2026-09-17T20:00:00.000Z'),
    },
  ]

  return (
    <TRPCProvider scopeKey="admin-ai-systems-visual-fixture">
      <AdminSectionShell routePathname="/admin/ai">
        <AdminAiSystemsView systems={systems as never} credentials={credentials as never} />
      </AdminSectionShell>
    </TRPCProvider>
  )
}
