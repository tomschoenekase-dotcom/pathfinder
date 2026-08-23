/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentOperationsOverview, formatE8Usd } from './AgentOperationsOverview'
import { AgentRunOperationsView } from './AgentRunOperationsView'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: {} }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

describe('agent operations views', () => {
  afterEach(cleanup)

  it('formats fixed-point agent costs without floating-point conversion', () => {
    expect(formatE8Usd(0n)).toBe('$0.00')
    expect(formatE8Usd(123_450_000n)).toBe('$1.2345')
    expect(formatE8Usd(10_000_000_000_000_001n)).toBe('$100000000.00000001')
  })

  it('keeps access and autonomy separate and offers staged configuration without execution controls', () => {
    render(
      <AgentOperationsOverview
        tenantId="tenant_1"
        venueId="venue_1"
        identities={{
          items: [
            {
              id: 'agent_1',
              identityKey: 'support',
              name: 'Support agent',
              description: null,
              agentType: 'SUPPORT',
              accessScope: 'VENUE',
              accessCapabilities: ['READ_CONTENT'],
              autonomyLevel: 'DRAFT',
              autonomousActions: [],
              defaultProvider: null,
              defaultModel: null,
              enabled: true,
              updatedAt: new Date('2026-08-11T14:30:00.000Z'),
              _count: { runs: 2, approvalRequests: 1 },
            },
          ],
          nextCursor: null,
        }}
        runs={{ items: [], nextCursor: null }}
        approvals={{ items: [], nextCursor: null }}
        questions={{ items: [], nextCursor: null }}
      />,
    )
    expect(screen.getByText('Access scope')).toBeTruthy()
    expect(screen.getByText('Autonomy')).toBeTruthy()
    expect(screen.getByText('READ_CONTENT')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create disabled identity' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /enable|run agent/i })).toBeNull()
    expect(screen.getByText(/answering a question never grants approval by itself/)).toBeTruthy()
  })

  it('shows a provider as connected only while its exact bridge session is online and unexpired', () => {
    render(
      <AgentOperationsOverview
        tenantId="tenant_1"
        venueId="venue_1"
        identities={{ items: [], nextCursor: null }}
        runs={{ items: [], nextCursor: null }}
        approvals={{ items: [], nextCursor: null }}
        questions={{ items: [], nextCursor: null }}
        bridgeSessions={[
          {
            id: 'session_1',
            provider: 'CODEX_SUBSCRIPTION',
            label: 'Codex desktop',
            runnerVersion: '1.0.0',
            supportedModels: ['subscription-default'],
            status: 'ONLINE',
            lastHeartbeatAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            _count: { agentRuns: 0 },
          },
        ]}
      />,
    )
    expect(screen.getAllByText('Runner online')).toHaveLength(1)
    expect(screen.getByText('Codex desktop')).toBeTruthy()
  })

  it('shows lifecycle, actions, timeline, costs, and approval state on run detail', () => {
    render(
      <AgentRunOperationsView
        tenantId="tenant_1"
        venueId="venue_1"
        run={{
          id: 'run_1',
          runType: 'SUPPORT',
          requestedOperation: 'draft_reply',
          status: 'AWAITING_APPROVAL',
          modelProvider: 'provider',
          modelName: 'model',
          costE8Usd: 25_000_000n,
          errorCode: null,
          errorMessage: null,
          initiatedByType: 'HUMAN',
          initiatedById: 'operator_1',
          cancelRequestedAt: null,
          startedAt: new Date('2026-08-11T12:00:00Z'),
          completedAt: null,
          createdAt: new Date('2026-08-11T11:59:00Z'),
          updatedAt: new Date('2026-08-11T12:01:00Z'),
          agentIdentity: { id: 'agent_1', name: 'Support agent', enabled: true },
          _count: { actions: 1, timelineEvents: 1, approvalRequests: 1 },
        }}
        actions={{
          items: [
            {
              id: 'action_1',
              actorType: 'AGENT',
              requestedOperation: 'draft_reply',
              actionName: 'Draft response',
              inputSummary: 'Prepared a bounded draft.',
              modelProvider: 'provider',
              modelName: 'model',
              costE8Usd: 10_000_000n,
              status: 'SUCCEEDED',
              errorCode: null,
              errorMessage: null,
              beforeVersionRef: null,
              afterVersionRef: 'draft:v1',
              approvalDecisionId: null,
              createdAt: new Date('2026-08-11T12:00:30Z'),
            },
          ],
          nextCursor: null,
        }}
        timeline={{
          items: [
            {
              id: 'event_1',
              actorType: 'SYSTEM',
              eventType: 'AWAITING_APPROVAL',
              message: 'Approval requested.',
              agentActionId: 'action_1',
              createdAt: new Date('2026-08-11T12:01:00Z'),
            },
          ],
          nextCursor: null,
        }}
        approvals={{
          items: [
            {
              id: 'approval_1',
              proposedAction: 'Send response',
              reason: 'External communication',
              riskCategory: 'HIGH',
              state: 'PENDING',
              expiresAt: null,
              createdAt: new Date('2026-08-11T12:01:00Z'),
              decision: null,
              customerAccessRequest: {
                id: 'access_1',
                targetEmail: 'new.member@example.com',
                requestedRole: 'MEMBER',
                status: 'AWAITING_APPROVAL',
                supportRequestId: 'support_1',
                sourceSupportMessageId: 'message_1',
                providerInvitationId: null,
              },
            },
          ],
          nextCursor: null,
        }}
        trace={{
          items: [
            {
              id: 'trace_event_1',
              kind: 'EVENT',
              actorType: 'SYSTEM',
              actorId: 'scheduler',
              eventType: 'RUN_COMPLETED',
              message: 'Unified evidence recorded.',
              agentActionId: null,
              createdAt: new Date('2026-08-11T12:02:00Z'),
            },
          ],
          nextCursor: null,
          bounded: true,
          excludes: ['RAW_ACTION_OUTPUT'],
        }}
      />,
    )
    expect(screen.getByText('Lifecycle')).toBeTruthy()
    expect(screen.getByText('Unified run trace')).toBeTruthy()
    expect(screen.getByText('Unified evidence recorded.')).toBeTruthy()
    expect(within(screen.getByLabelText('Run summary')).getByText('$0.25')).toBeTruthy()
    expect(screen.getByText('Prepared a bounded draft.')).toBeTruthy()
    expect(screen.getByText('Approval requested.')).toBeTruthy()
    expect(screen.getByText('PENDING')).toBeTruthy()
    expect(screen.getByText('new.member@example.com')).toBeTruthy()
    expect(screen.getByText('No invitation sent')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /enable|run agent|retry|approve/i })).toBeNull()
  })
})
