import { FounderTwoMinuteBoard } from '../../../components/admin/FounderTwoMinuteBoard'

function data(size: number) {
  const questions = Array.from({ length: size }, (_, index) => ({
    id: `fixture-question-${index}`,
    tenantId: `fixture-tenant-${index}`,
    venueId: `fixture-venue-${index}`,
    agentRunId: null,
    question:
      index === size - 1
        ? 'Visitor chat is failing at the west entrance'
        : `Confirm low-impact source label ${index + 1}`,
    context:
      index === size - 1
        ? 'A recorded failure is blocking visitor answers at one venue.'
        : 'This source label does not block other venue work.',
    questionType: 'YES_NO',
    category: 'deterministic-fixture',
    urgency: index === size - 1 ? 'URGENT' : 'LOW',
    choices: ['Yes', 'No'],
    dueAt: null,
    evidence: [],
    proposedAnswer: null,
    blocking: index === size - 1,
    createdAt: new Date('2026-09-07T10:00:00.000Z'),
    updatedAt: new Date('2026-09-07T10:00:00.000Z'),
    agentIdentity: { name: 'Fixture observer' },
    agentRun: null,
  }))
  return {
    questions: {
      items: questions,
      nextCursor: { createdAt: '2026-09-07T09:00:00.000Z', id: 'older-record' },
    },
    approvals: { items: [], nextCursor: null },
    events: { items: [], nextCursor: null },
    platformEvents: { items: [], nextCursor: null },
    blockedAgents: { items: [], nextCursor: null },
    completedAgents: {
      items: [
        {
          id: 'fixture-complete',
          agentIdentityId: 'fixture-agent',
          tenantId: 'fixture-tenant',
          venueId: 'fixture-venue',
          runType: 'REVIEW',
          requestedOperation: 'Verify retained arrival guidance',
          status: 'COMPLETED',
          completedAt: new Date('2026-09-07T09:30:00.000Z'),
          createdAt: new Date('2026-09-07T09:00:00.000Z'),
          agentIdentity: { id: 'fixture-agent', name: 'Evidence reviewer' },
          _count: { outcomeObservations: 1 },
        },
      ],
      nextCursor: null,
    },
  } as never
}

export default async function FounderTwoMinuteBoardFixture({
  searchParams,
}: {
  searchParams: Promise<{ size?: string }>
}) {
  const requested = Number((await searchParams).size)
  const size = requested === 5 || requested === 50 || requested === 500 ? requested : 50
  return (
    <main className="min-h-screen bg-slate-100 px-3 py-5 text-slate-950 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-slate-600">
          Deterministic load fixture · {size} venue records · no customer claims
        </p>
        <FounderTwoMinuteBoard data={data(size)} />
      </div>
    </main>
  )
}
