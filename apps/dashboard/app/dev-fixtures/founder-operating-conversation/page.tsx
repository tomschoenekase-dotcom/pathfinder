import type { ComponentProps } from 'react'

import { FounderOperatingConversation } from '../../../components/admin/FounderOperatingConversation'
import { TRPCProvider } from '../../../lib/trpc'

type Exchanges = ComponentProps<typeof FounderOperatingConversation>['exchanges']

const exchanges: Exchanges = [
  {
    id: 'exchange-answer',
    operationId: '11111111-1111-4111-8111-111111111111',
    prompt: 'What needs my decision?',
    intent: 'DECISIONS',
    disposition: 'ANSWERED',
    responseTitle: '2 founder decisions visible',
    responseBody: 'One question and one approval need review.',
    evidence: [
      {
        label: 'Choose a customer exception',
        detail: 'Hermes is waiting for founder judgment.',
        href: '#decision-evidence',
        scope: 'TENANT',
        objectType: 'agent-question',
        objectId: 'question-fixture',
        tenantId: 'tenant-fixture',
        venueId: 'venue-fixture',
      },
    ],
    snapshot: {},
    snapshotHash: 'a'.repeat(64),
    createdAt: new Date('2026-08-25T12:00:00.000Z'),
  },
  {
    id: 'exchange-directive',
    operationId: '22222222-2222-4222-8222-222222222222',
    prompt: 'Prepare the next Las Vegas venue segment for review.',
    intent: 'DIRECTIVE',
    disposition: 'RECORDED_FOR_TRIAGE',
    responseTitle: 'Direction recorded for triage',
    responseBody:
      'This direction is visible to authorized platform operating workers. Nothing was executed, approved, sent, priced, billed, deployed, purchased, or adopted as policy.',
    evidence: [],
    snapshot: {},
    snapshotHash: 'b'.repeat(64),
    createdAt: new Date('2026-08-25T11:45:00.000Z'),
  },
]

export default function FounderOperatingConversationFixturePage() {
  return (
    <TRPCProvider scopeKey="founder-operating-conversation-fixture">
      <main className="min-h-screen bg-slate-100 p-3 sm:p-8">
        <div className="mx-auto max-w-5xl">
          <FounderOperatingConversation exchanges={exchanges} />
        </div>
      </main>
    </TRPCProvider>
  )
}
