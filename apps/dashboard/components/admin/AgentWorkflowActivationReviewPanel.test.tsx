// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  request: vi.fn(),
  apply: vi.fn(),
  transition: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      getAgentIdentity: { query: mocks.identity },
      requestAgentWorkflowActivationApproval: { mutate: mocks.request },
      applyAgentWorkflowActivation: { mutate: mocks.apply },
      applyAgentWorkflowTransition: { mutate: mocks.transition },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('./ApprovalDecisionForm', () => ({ ApprovalDecisionForm: () => <div>Decision form</div> }))

import {
  AgentWorkflowActivationReviewPanel,
  type AgentWorkflowActivationReviewPage,
} from './AgentWorkflowActivationReviewPanel'

const page = {
  candidates: [
    {
      version: {
        id: '11111111-1111-4111-8111-111111111111',
        registryKey: 'review',
        version: 2,
        requiredToolCapabilities: [],
        artifactIntegrity: 'NOT_CHECKED_BODY_ON_APPLY',
      },
      compatibility: { status: 'CURRENTLY_AVAILABLE', missingCapabilities: [] },
      assessment: {
        id: 'assessment',
        diagnosticsShapeValid: true,
        diagnostics: {
          development: {
            caseCount: 2,
            resolvedFailures: 1,
            newFailures: 0,
            missingResults: 0,
            latencyDeltaMs: null,
            costDeltaE8Usd: null,
          },
          heldout: {
            caseCount: 2,
            resolvedFailures: 1,
            newFailures: 0,
            missingResults: 0,
            latencyDeltaMs: null,
            costDeltaE8Usd: null,
          },
          limitations: ['Human review required.'],
        },
      },
    },
  ],
  enabledIdentities: [{ id: 'identity', identityKey: 'quality', name: 'Quality reviewer' }],
  approvalRequests: [],
  heads: [{ registryKey: 'review', revision: 0, activeVersion: null }],
} as unknown as AgentWorkflowActivationReviewPage
const receiptPolicy = {
  numerator: 1,
  denominator: 10,
  maxSelectedRuns: 5,
  salt: 'persisted-visible-selection-salt',
  startsAt: '2026-09-07T17:00:00.000Z',
  endsAt: '2026-09-08T17:00:00.000Z',
  eligibleRunTypes: ['QUALITY_REVIEW'],
  eligibleOperations: ['operator_task'],
  supportedActionClasses: ['RUN_TERMINAL_WRITE'],
  skippedBaseline: { kind: 'NO_WORKFLOW' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.identity.mockResolvedValue({ agentType: 'QUALITY_REVIEW' })
  mocks.request.mockResolvedValue({ request: { id: 'request' } })
})
afterEach(cleanup)

describe('AgentWorkflowActivationReviewPanel', () => {
  it('starts without a hidden canary and submits explicit runtime-bound fields', async () => {
    render(
      <AgentWorkflowActivationReviewPanel tenantId="tenant" venueId="venue" initialPage={page} />,
    )
    const submit = screen.getByRole('button', {
      name: 'Request human approval',
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Candidate version'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    })
    fireEvent.change(screen.getByLabelText('Bookkeeping identity'), {
      target: { value: 'identity' },
    })
    await waitFor(() => expect(document.body.textContent).toContain('QUALITY_REVIEW'))
    fireEvent.change(screen.getByLabelText('Selection denominator'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Maximum selected runs'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '2026-09-07T12:00' } })
    fireEvent.change(screen.getByLabelText('Ends at'), { target: { value: '2026-09-08T12:00' } })
    fireEvent.change(screen.getByLabelText('Visible selection salt'), {
      target: { value: 'explicit-reviewed-salt' },
    })
    fireEvent.click(screen.getByLabelText('No workflow'))
    fireEvent.click(screen.getByLabelText('Use canonical operator_task'))
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'Reviewed bounded canary.' },
    })
    expect(submit.disabled).toBe(true)
    fireEvent.submit(submit.closest('form')!)
    expect(mocks.request).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Selected numerator'), { target: { value: '1' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))
    expect(mocks.request.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant',
      venueId: 'venue',
      agentIdentityId: 'identity',
      canaryPolicy: {
        eligibleRunTypes: ['QUALITY_REVIEW'],
        eligibleOperations: ['operator_task'],
        supportedActionClasses: ['RUN_TERMINAL_WRITE'],
      },
    })
  })

  it('retries an uncertain request with the exact frozen operation and payload', async () => {
    mocks.request
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ request: { id: 'request' } })
    const view = render(
      <AgentWorkflowActivationReviewPanel tenantId="tenant" venueId="venue" initialPage={page} />,
    )
    fireEvent.change(screen.getByLabelText('Candidate version'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    })
    fireEvent.change(screen.getByLabelText('Bookkeeping identity'), {
      target: { value: 'identity' },
    })
    await waitFor(() => expect(document.body.textContent).toContain('QUALITY_REVIEW'))
    for (const [label, value] of [
      ['Selected numerator', '1'],
      ['Selection denominator', '10'],
      ['Maximum selected runs', '5'],
      ['Starts at', '2026-09-07T12:00'],
      ['Ends at', '2026-09-08T12:00'],
      ['Visible selection salt', 'explicit-reviewed-salt'],
      ['Review reason', 'Reviewed bounded canary.'],
    ] as const)
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fireEvent.click(screen.getByLabelText('No workflow'))
    fireEvent.click(screen.getByLabelText('Use canonical operator_task'))
    fireEvent.click(screen.getByRole('button', { name: 'Request human approval' }))
    await screen.findByText(/outcome is uncertain/)
    view.rerender(
      <AgentWorkflowActivationReviewPanel
        tenantId="tenant"
        venueId="venue"
        initialPage={{ ...page }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact request' }))
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
    expect(mocks.request.mock.calls[1]?.[0]).toEqual(mocks.request.mock.calls[0]?.[0])
  })

  it.each(['APPLIED', 'AMBIGUOUS'] as const)(
    'suppresses Apply for %s event correlation',
    (correlation) => {
      const history = {
        ...page,
        approvalRequests: [
          {
            id: 'request-one',
            proposedAction: 'agent-workflow.activate',
            reason: 'Reviewed.',
            receiptShapeValid: true,
            decision: { decision: 'APPROVED' },
            receipt: { registryKey: 'review' },
            reviewedApplyInput: {
              approvalDecisionId: 'decision',
              receipt: { registryKey: 'review' },
            },
            appliedEventCorrelation: correlation,
            appliedEvent: correlation === 'APPLIED' ? { resultingRevision: 2 } : null,
          },
        ],
      } as unknown as AgentWorkflowActivationReviewPage
      render(
        <AgentWorkflowActivationReviewPanel
          tenantId="tenant"
          venueId="venue"
          initialPage={history}
        />,
      )
      expect(screen.queryByRole('button', { name: /Apply reviewed/ })).toBeNull()
      expect(document.body.textContent).toContain(
        correlation === 'APPLIED'
          ? 'Applied · revision 2'
          : 'Event correlation needs investigation',
      )
    },
  )

  it('does not allow a new request while an uncertain Apply is frozen', async () => {
    mocks.apply.mockRejectedValueOnce(new Error('network'))
    const history = {
      ...page,
      approvalRequests: [
        {
          id: 'request-one',
          proposedAction: 'agent-workflow.activate',
          reason: 'Reviewed.',
          receiptShapeValid: true,
          decision: { decision: 'APPROVED' },
          expiresAt: '2026-09-09T17:00:00.000Z',
          receipt: {
            registryKey: 'review',
            workflowVersionId: '11111111-1111-4111-8111-111111111111',
            promotionAssessmentId: 'assessment',
            expectedHeadRevision: 3,
            canaryPolicy: receiptPolicy,
            evidenceDigest: 'a'.repeat(64),
          },
          reviewedApplyInput: {
            approvalDecisionId: 'decision',
            receipt: { registryKey: 'review' },
          },
          appliedEventCorrelation: 'NONE',
          appliedEvent: null,
        },
      ],
    } as unknown as AgentWorkflowActivationReviewPage
    render(
      <AgentWorkflowActivationReviewPanel
        tenantId="tenant"
        venueId="venue"
        initialPage={history}
      />,
    )
    fireEvent.click(screen.getByText('Review approval terms'))
    expect(document.body.textContent).toContain('persisted-visible-selection-salt')
    expect(document.body.textContent).toContain('QUALITY_REVIEW')
    expect(document.body.textContent).toContain('operator_task')
    expect((screen.getByLabelText('Selected numerator') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed activate' }))
    await screen.findByText(/Apply outcome is uncertain/)
    const request = screen.getByRole('button', {
      name: 'Request human approval',
    }) as HTMLButtonElement
    expect(request.disabled).toBe(true)
    fireEvent.submit(request.closest('form')!)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Retry exact Apply' })).toBeTruthy()
  })

  it('keeps a same-scope request locked while refreshed props arrive', async () => {
    let resolveRequest!: (value: { request: { id: string } }) => void
    mocks.request.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      }),
    )
    const view = render(
      <AgentWorkflowActivationReviewPanel tenantId="tenant" venueId="venue" initialPage={page} />,
    )
    fireEvent.change(screen.getByLabelText('Candidate version'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    })
    fireEvent.change(screen.getByLabelText('Bookkeeping identity'), {
      target: { value: 'identity' },
    })
    await waitFor(() => expect(document.body.textContent).toContain('QUALITY_REVIEW'))
    for (const [label, value] of [
      ['Selected numerator', '1'],
      ['Selection denominator', '10'],
      ['Maximum selected runs', '5'],
      ['Starts at', '2026-09-07T12:00'],
      ['Ends at', '2026-09-08T12:00'],
      ['Visible selection salt', 'explicit-reviewed-salt'],
      ['Review reason', 'Reviewed bounded canary.'],
    ] as const)
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fireEvent.click(screen.getByLabelText('No workflow'))
    fireEvent.click(screen.getByLabelText('Use canonical operator_task'))
    fireEvent.click(screen.getByRole('button', { name: 'Request human approval' }))
    expect(mocks.request).toHaveBeenCalledTimes(1)

    view.rerender(
      <AgentWorkflowActivationReviewPanel
        tenantId="tenant"
        venueId="venue"
        initialPage={{ ...page }}
      />,
    )
    const submit = screen.getByRole('button', {
      name: 'Request human approval',
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    expect(mocks.request).toHaveBeenCalledTimes(1)
    resolveRequest({ request: { id: 'request' } })
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1))
  })

  it('ignores an original A identity response after an A to B to A scope cycle', async () => {
    let resolveOldA!: (value: { agentType: string }) => void
    mocks.identity
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldA = resolve
        }),
      )
      .mockResolvedValueOnce({ agentType: 'CURRENT_A' })
    const view = render(
      <AgentWorkflowActivationReviewPanel tenantId="tenant" venueId="venue-a" initialPage={page} />,
    )
    fireEvent.change(screen.getByLabelText('Bookkeeping identity'), {
      target: { value: 'identity' },
    })
    view.rerender(
      <AgentWorkflowActivationReviewPanel tenantId="tenant" venueId="venue-b" initialPage={page} />,
    )
    await screen.findByText('No workflow approval requests recorded.')
    view.rerender(
      <AgentWorkflowActivationReviewPanel tenantId="tenant" venueId="venue-a" initialPage={page} />,
    )
    await screen.findByText('No workflow approval requests recorded.')
    fireEvent.change(screen.getByLabelText('Bookkeeping identity'), {
      target: { value: 'identity' },
    })
    await waitFor(() => expect(document.body.textContent).toContain('CURRENT_A'))
    resolveOldA({ agentType: 'STALE_A' })
    await Promise.resolve()
    expect(document.body.textContent).toContain('CURRENT_A')
    expect(document.body.textContent).not.toContain('STALE_A')
  })
})
