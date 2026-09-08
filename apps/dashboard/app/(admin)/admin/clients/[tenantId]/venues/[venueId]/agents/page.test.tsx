/* @vitest-environment jsdom */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  listAgentIdentities: vi.fn(),
  listAgentRuns: vi.fn(),
  listApprovalRequests: vi.fn(),
  listAgentQuestions: vi.fn(),
  listAgentApprovalPolicies: vi.fn(),
  listAgentOutcomeObservations: vi.fn(),
  listAgentBridgeSessions: vi.fn(),
  listOnboardingQuestionRecipients: vi.fn(),
  listAgentWorkflowActivations: vi.fn(),
  getAgentWorkflowActivationReview: vi.fn(),
}))

vi.mock('../../../../../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({ admin: mocks }),
}))
vi.mock('@pathfinder/config', () => ({ env: { AGENT_RUNNER_ENABLED: false } }))
vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: 'test-admin' }) }))
vi.mock('../../../../../../../../components/admin/AgentOperationsOverview', () => ({
  agentQuestionStatusFilters: ['PENDING', 'ANSWERED', 'DISMISSED', 'EXPIRED', 'CANCELLED', 'ALL'],
  AgentOperationsOverview: ({
    questionStatus,
    questions,
  }: {
    questionStatus: string
    questions: { items: Array<{ id: string }> }
  }) => <p>{`${questionStatus}:${questions.items.map((question) => question.id).join(',')}`}</p>,
}))

import AgentOperationsPage from './page'

describe('AgentOperationsPage question history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const mock of Object.values(mocks)) mock.mockResolvedValue({ items: [], nextCursor: null })
  })

  it('loads the selected canonical question status with its bounded cursor', async () => {
    mocks.listAgentQuestions.mockResolvedValue({
      items: [{ id: 'question_answered' }],
      nextCursor: null,
    })

    const page = await AgentOperationsPage({
      params: Promise.resolve({ tenantId: 'tenant_1', venueId: 'venue_1' }),
      searchParams: Promise.resolve({
        questionStatus: 'ANSWERED',
        questionCursorCreatedAt: '2026-09-08T15:00:00.000Z',
        questionCursorId: 'question_older',
      }),
    })

    expect(mocks.listAgentQuestions).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      status: 'ANSWERED',
      limit: 20,
      cursor: { createdAt: '2026-09-08T15:00:00.000Z', id: 'question_older' },
    })
    expect(renderToStaticMarkup(page)).toContain('ANSWERED:question_answered')
  })

  it('falls back to the pending inbox for an unrecognized status', async () => {
    const page = await AgentOperationsPage({
      params: Promise.resolve({ tenantId: 'tenant_1', venueId: 'venue_1' }),
      searchParams: Promise.resolve({ questionStatus: 'UNRECOGNIZED' }),
    })

    expect(mocks.listAgentQuestions).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      status: 'PENDING',
      limit: 20,
    })
    expect(renderToStaticMarkup(page)).toContain('PENDING:')
  })
})
