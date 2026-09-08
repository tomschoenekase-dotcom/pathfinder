import { notFound } from 'next/navigation'
import type { ComponentProps } from 'react'

import { FounderQuestionTriageBoard } from '../../../components/admin/FounderQuestionTriageBoard'
import { TRPCProvider } from '../../../lib/trpc'

export const metadata = { title: 'Founder question grouping fixture' }

const fixtureEnabled =
  process.env.NODE_ENV === 'development' && process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED === '1'
const generatedAt = new Date('2026-09-08T16:00:00.000Z')
type Questions = ComponentProps<typeof FounderQuestionTriageBoard>['questions']
type Question = Questions['items'][number]

function question(input: {
  id: string
  tenantId: string
  venueId: string
  venueName: string
  agentRunId: string | null
  runOperation?: string
  prompt: string
  urgency: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW'
  blocking: boolean
  createdAt: string
  dueAt?: string | null
  expiresAt?: string | null
}): Question {
  return {
    id: input.id,
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentRunId: input.agentRunId,
    question: input.prompt,
    context: `Retained evidence for ${input.id}; review changes no public content by itself.`,
    questionType: 'YES_NO',
    category: 'operational-clarification',
    urgency: input.urgency,
    choices: ['Confirm', 'Keep pending'],
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    evidence: [
      {
        label: 'Retained source',
        reference: `fixture-evidence:${input.id}`,
        summary: 'A bounded fixture reference remains attached to this individual question.',
        kind: 'DOCUMENT_EXCERPT',
      },
    ],
    proposedAnswer: null,
    blocking: input.blocking,
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(input.createdAt),
    agentIdentity: { name: 'Operations analyst' },
    venue: { name: input.venueName },
    agentRun: input.agentRunId
      ? {
          id: input.agentRunId,
          status: 'AWAITING_INPUT',
          requestedOperation: input.runOperation ?? 'venue-operations-review',
        }
      : null,
  }
}

const questions: Questions = {
  items: [
    question({
      id: 'grouping-shared-urgent',
      tenantId: 'tenant-north',
      venueId: 'venue-north',
      venueName: 'North Gallery',
      agentRunId: 'shared-run-reference',
      runOperation: 'arrival-readiness-review',
      prompt: 'Is the accessible north entrance ready for today’s visitors?',
      urgency: 'URGENT',
      blocking: true,
      createdAt: '2026-09-08T12:00:00.000Z',
      dueAt: '2026-09-08T16:00:00.000Z',
      expiresAt: '2026-09-08T18:00:00.000Z',
    }),
    question({
      id: 'grouping-shared-second',
      tenantId: 'tenant-north',
      venueId: 'venue-north',
      venueName: 'North Gallery',
      agentRunId: 'shared-run-reference',
      runOperation: 'arrival-readiness-review',
      prompt: 'Should the temporary arrival sign remain beside that entrance?',
      urgency: 'HIGH',
      blocking: true,
      createdAt: '2026-09-08T12:10:00.000Z',
      dueAt: '2026-09-08T17:00:00.000Z',
    }),
    question({
      id: 'grouping-independent-run',
      tenantId: 'tenant-north',
      venueId: 'venue-north',
      venueName: 'North Gallery',
      agentRunId: 'independent-run',
      runOperation: 'cafe-hours-review',
      prompt: 'Are the café holiday hours still current?',
      urgency: 'NORMAL',
      blocking: false,
      createdAt: '2026-09-08T12:20:00.000Z',
    }),
    question({
      id: 'grouping-foreign-same-run-string',
      tenantId: 'tenant-south',
      venueId: 'venue-south',
      venueName: 'South Museum',
      agentRunId: 'shared-run-reference',
      runOperation: 'arrival-readiness-review',
      prompt: 'Is the south loading entrance excluded from visitor directions?',
      urgency: 'HIGH',
      blocking: true,
      createdAt: '2026-09-08T12:30:00.000Z',
    }),
    question({
      id: 'grouping-runless-one',
      tenantId: 'tenant-north',
      venueId: 'venue-north',
      venueName: 'North Gallery',
      agentRunId: null,
      prompt: 'Should the River Room alias remain searchable?',
      urgency: 'LOW',
      blocking: false,
      createdAt: '2026-09-08T12:40:00.000Z',
    }),
    question({
      id: 'grouping-runless-two',
      tenantId: 'tenant-north',
      venueId: 'venue-north',
      venueName: 'North Gallery',
      agentRunId: null,
      prompt: 'Does the seasonal coat-check note need another source?',
      urgency: 'NORMAL',
      blocking: false,
      createdAt: '2026-09-08T12:50:00.000Z',
    }),
  ],
  nextCursor: null,
}

export default function FounderQuestionGroupingFixture() {
  if (!fixtureEnabled) notFound()
  return (
    <TRPCProvider scopeKey="founder-question-grouping-fixture">
      <main
        data-fixture="founder-question-grouping"
        className="min-h-screen bg-slate-100 px-3 py-6 text-slate-950 sm:px-6 lg:px-10"
      >
        <section className="mx-auto max-w-6xl rounded-2xl border border-amber-200 bg-amber-50/70 p-4 shadow-sm sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-800">
            Founder decisions · deterministic fixture
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Workflow grouping</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Grouped review keeps every question and its individual controls visible within the exact
            tenant, venue, and workflow scope.
          </p>
          <FounderQuestionTriageBoard questions={questions} generatedAt={generatedAt} />
        </section>
      </main>
    </TRPCProvider>
  )
}
