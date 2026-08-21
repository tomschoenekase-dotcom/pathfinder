/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./OperationalEventActions', () => ({
  OperationalEventActions: () => <span>Event actions</span>,
}))

import { OperationsAttentionConsole } from './OperationsAttentionConsole'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const empty = {
  generatedAt: new Date('2026-08-11T14:30:00.000Z'),
  jobs: { items: [], nextCursor: null },
  evaluations: { items: [], nextCursor: null },
  approvals: { items: [], nextCursor: null },
  support: { items: [], nextCursor: null },
  agents: { items: [], nextCursor: null },
  questions: { items: [], nextCursor: null },
  workingAgents: { items: [], nextCursor: null },
  blockedAgents: { items: [], nextCursor: null },
  completedAgents: { items: [], nextCursor: null },
  outcomes: { items: [], nextCursor: null },
  events: { items: [], nextCursor: null },
  platformEvents: { items: [], nextCursor: null },
  workers: [],
}

describe('operations attention console', () => {
  afterEach(cleanup)

  it('renders honest empty states for every bounded queue', () => {
    render(<OperationsAttentionConsole data={empty} />)
    expect(screen.getByText('No failed job records need attention.')).toBeTruthy()
    expect(screen.getByText(/No evaluation runs currently match/)).toBeTruthy()
    expect(screen.getByText('No undecided approval requests are recorded.')).toBeTruthy()
    expect(screen.getByText(/No support requests currently match/)).toBeTruthy()
    expect(screen.getByText('No agents are waiting for human input.')).toBeTruthy()
    expect(screen.getByText('No agent work is queued or running.')).toBeTruthy()
    expect(screen.getByText('No agent runs are blocked or failed.')).toBeTruthy()
    expect(screen.getByText('No completed agent runs are recorded.')).toBeTruthy()
    expect(screen.getByText('No outcome observations are recorded yet.')).toBeTruthy()
    expect(screen.getByText(/review linked evidence/i)).toBeTruthy()
    expect(screen.getByText('No operational alerts currently need attention.')).toBeTruthy()
    expect(screen.getByText('No platform CRM alerts currently need attention.')).toBeTruthy()
    expect(screen.getByText('No compatible workers have registered.')).toBeTruthy()
  })

  it('puts human questions first and links to the durable agent inbox', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          questions: {
            items: [
              {
                id: 'question_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                agentRunId: 'run_1',
                question: 'Which pricing assumption should I use?',
                context: 'Two sources disagree.',
                questionType: 'MULTIPLE_CHOICE',
                category: 'pricing',
                urgency: 'HIGH',
                choices: ['Current list price', 'Last signed agreement'],
                dueAt: null,
                evidence: [],
                proposedAnswer: null,
                blocking: true,
                createdAt: new Date(),
                agentIdentity: { name: 'Research' },
                agentRun: { id: 'run_1', status: 'AWAITING_INPUT', requestedOperation: 'pricing' },
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy()
    expect(screen.getByText('Which pricing assumption should I use?')).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Answer in agent workspace' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/agents#inbox')
  })

  it('links attention items to exact tenant and venue evidence without raw details', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          evaluations: {
            items: [
              {
                id: 'eval_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                status: 'RUNNING',
                attemptNumber: 2,
                maxAttempts: 3,
                executionLeaseExpiresAt: new Date(),
                lastErrorCode: null,
                createdAt: new Date(),
                expiredLease: true,
              },
            ],
            nextCursor: null,
          },
          support: {
            items: [
              {
                id: 'request_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                category: 'CONTENT_CORRECTION',
                status: 'VALIDATING',
                subject: 'Hours review',
                version: 2,
                onboardingQuestionLink: { id: 'link_1', agentQuestionId: 'question_1' },
                updatedAt: new Date(),
                createdAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )
    expect(
      screen.getByRole('link', { name: 'Open evaluation evidence' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/evaluations')
    expect(screen.getByRole('link', { name: 'Open scoped request' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/support-operations?requestId=request_1',
    )
    expect(screen.getByText('Onboarding blocker')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open blocked work' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/agents#inbox',
    )
    expect(screen.getByText('Lease expired')).toBeTruthy()
    expect(screen.queryByText('secret provider payload')).toBeNull()
  })

  it('routes knowledge proposal events to the review workspace', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          events: {
            items: [
              {
                id: 'event_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                eventType: 'knowledge.proposal.created',
                sourceSubsystem: 'knowledge',
                severity: 'WARNING',
                title: 'Knowledge update proposed',
                summary: 'A grounded update is ready for review.',
                recommendedAction: 'Review the evidence.',
                state: 'OPEN',
                actionRequired: true,
                linkedObjectType: 'KnowledgeChangeProposal',
                linkedObjectId: 'proposal_1',
                occurrenceCount: 1,
                createdAt: new Date(),
                lastOccurredAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )

    expect(screen.getByRole('link', { name: 'Open related workspace' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/knowledge-proposals',
    )
  })

  it('renders platform CRM attention without a fabricated tenant link', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          platformEvents: {
            items: [
              {
                id: '00000000-0000-4000-8000-000000000001',
                eventType: 'crm.import.completed_with_issues',
                sourceSubsystem: 'prospect-crm',
                severity: 'WARNING',
                title: 'Prospect import completed with issues',
                summary: 'Review quarantined rows.',
                recommendedAction: 'Review the bounded report.',
                state: 'OPEN',
                actionRequired: true,
                linkedObjectType: 'ProspectImport',
                linkedObjectId: 'import_1',
                occurrenceCount: 1,
                createdAt: new Date(),
                lastOccurredAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )

    expect(screen.getByText('Prospect import completed with issues')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open related workspace' }).getAttribute('href')).toBe(
      '/admin/prospects/imports',
    )
  })
})
