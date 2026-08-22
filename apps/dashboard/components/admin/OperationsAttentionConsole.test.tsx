/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./OperationalEventActions', () => ({
  OperationalEventActions: () => <span>Event actions</span>,
}))
vi.mock('./AgentQuestionAnswerForm', () => ({
  AgentQuestionAnswerForm: () => <span>Inline question answer</span>,
}))
vi.mock('./ApprovalDecisionForm', () => ({
  ApprovalDecisionForm: () => <span>Inline approval decision</span>,
}))

import { OperationsAttentionConsole } from './OperationsAttentionConsole'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

type Data = React.ComponentProps<typeof OperationsAttentionConsole>['data']

const empty: Data = {
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
  briefing: {
    schemaVersion: 1,
    focus: {
      kind: 'CLEAR',
      urgency: 'NONE',
      label: 'No urgent founder action',
      title: 'The operating queues are clear.',
      detail: 'No urgent work is visible.',
      action: { label: 'See what agents are doing', href: '/admin/operations#ai-workforce' },
      source: {
        scope: 'PLATFORM',
        objectType: 'attention-console',
        objectId: null,
        tenantId: null,
        venueId: null,
      },
    },
    metrics: { decisions: 0, criticalRisks: 0, workingAgents: 0, customerItems: 0 },
    boundedSnapshot: { limit: 10, hasMore: false },
  },
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
    expect(screen.getByRole('heading', { name: 'Your next five minutes' })).toBeTruthy()
    expect(screen.getByText('The operating queues are clear.')).toBeTruthy()
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
                updatedAt: new Date(),
                agentIdentity: { name: 'Research' },
                agentRun: { id: 'run_1', status: 'AWAITING_INPUT', requestedOperation: 'pricing' },
              },
            ],
            nextCursor: null,
          },
          briefing: {
            ...empty.briefing,
            focus: {
              kind: 'FOUNDER_QUESTION',
              urgency: 'HIGH',
              label: 'Founder decision',
              title: 'Which pricing assumption should I use?',
              detail: 'Two sources disagree.',
              action: { label: 'Answer here', href: '/admin/operations#needs-you-heading' },
              source: {
                scope: 'TENANT',
                objectType: 'agent-question',
                objectId: 'question_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
              },
            },
            metrics: { ...empty.briefing.metrics, decisions: 1 },
          },
        }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy()
    expect(screen.getAllByText('Which pricing assumption should I use?')).toHaveLength(2)
    expect(screen.getByText('Inline question answer')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open full agent context' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/agents#inbox',
    )
  })

  it('surfaces a critical customer event ahead of routine decisions', () => {
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
                question: 'Can this wait?',
                context: null,
                questionType: 'YES_NO',
                category: 'operations',
                urgency: 'NORMAL',
                choices: ['Yes', 'No'],
                dueAt: null,
                evidence: [],
                proposedAnswer: null,
                blocking: true,
                createdAt: new Date(),
                updatedAt: new Date(),
                agentIdentity: { name: 'Operator' },
                agentRun: { id: 'run_1', status: 'AWAITING_INPUT', requestedOperation: 'review' },
              },
            ],
            nextCursor: null,
          },
          events: {
            items: [
              {
                id: 'event_critical',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                eventType: 'guest-chat.provider-failure',
                sourceSubsystem: 'guest-chat',
                severity: 'CRITICAL',
                title: 'Visitor chat is unavailable',
                summary: 'Guest questions are failing.',
                recommendedAction: 'Inspect the affected chat turns.',
                state: 'OPEN',
                actionRequired: true,
                linkedObjectType: 'guest-chat-turn',
                linkedObjectId: 'turn_1',
                occurrenceCount: 1,
                createdAt: new Date(),
                lastOccurredAt: new Date(),
              },
            ],
            nextCursor: null,
          },
          briefing: {
            ...empty.briefing,
            focus: {
              kind: 'CUSTOMER_RISK',
              urgency: 'CRITICAL',
              label: 'Customer or system risk',
              title: 'Visitor chat is unavailable',
              detail: 'Inspect the affected chat turns.',
              action: {
                label: 'Review risk now',
                href: '/admin/clients/tenant_1/venues/venue_1/chatlogs',
              },
              source: {
                scope: 'TENANT',
                objectType: 'operational-event',
                objectId: 'event_critical',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
              },
            },
            metrics: { ...empty.briefing.metrics, decisions: 1, criticalRisks: 1 },
          },
        }}
      />,
    )

    const briefing = screen.getByRole('heading', { name: 'Your next five minutes' }).parentElement
    expect(briefing?.textContent).toContain('Visitor chat is unavailable')
    expect(screen.getByRole('link', { name: 'Review risk now' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/chatlogs',
    )
  })

  it('puts an unexpired venue approval directly in the founder decision flow', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          approvals: {
            items: [
              {
                id: 'approval_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                proposedAction: 'Apply reviewed hours update',
                riskCategory: 'MEDIUM',
                expiresAt: new Date('2099-01-01T00:00:00.000Z'),
                createdAt: new Date(),
                agentIdentity: { name: 'Support operator' },
                expired: false,
              },
            ],
            nextCursor: null,
          },
          briefing: {
            ...empty.briefing,
            focus: {
              kind: 'APPROVAL',
              urgency: 'HIGH',
              label: 'Approval',
              title: 'Apply reviewed hours update',
              detail: 'Support operator · medium risk',
              action: {
                label: 'Make a decision',
                href: '/admin/operations#approval-attention-heading',
              },
              source: {
                scope: 'TENANT',
                objectType: 'approval-request',
                objectId: 'approval_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
              },
            },
            metrics: { ...empty.briefing.metrics, decisions: 1 },
          },
        }}
      />,
    )

    expect(screen.getByText('Inline approval decision')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Make a decision' }).getAttribute('href')).toBe(
      '/admin/operations#approval-attention-heading',
    )
    expect(
      screen.getByRole('link', { name: 'Open full approval context' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/agents#approvals')
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
