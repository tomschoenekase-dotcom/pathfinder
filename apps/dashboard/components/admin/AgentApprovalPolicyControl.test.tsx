/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

const issue = vi.fn().mockResolvedValue({ id: 'grant_new' })
const issueSupport = vi.fn().mockResolvedValue({ id: 'grant_support' })
const issueIntake = vi.fn().mockResolvedValue({ id: 'grant_intake' })
const revoke = vi.fn().mockResolvedValue({ id: 'grant_1' })
const refresh = vi.fn()

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      issueOperationalUpdateDraftPolicy: { mutate: issue },
      issueSupportRequestDraftPolicy: { mutate: issueSupport },
      issueIntakeNotesProposalPolicy: { mutate: issueIntake },
      revokeAgentApprovalPolicy: { mutate: revoke },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { AgentApprovalPolicyControl } from './AgentApprovalPolicyControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const baseProps = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  identity: {
    id: 'agent_1',
    identityKey: 'support.primary',
    enabled: true,
    accessCapabilities: ['updates:draft'],
  },
  outcomeObservations: [
    {
      id: 'outcome_1',
      agentRunId: 'run_1',
      signalKind: 'HUMAN_REVIEW',
      verdict: 'SUCCESS',
      summary: 'The reviewed draft was correct and stayed within scope.',
      evidenceRef: 'review:1',
      taskClass: 'OPERATIONAL_UPDATE_DRAFT',
      modelProvider: 'openai',
      modelName: 'gpt-5',
      createdAt: new Date('2030-01-01T10:00:00.000Z'),
    },
  ],
  policies: [],
}

describe('AgentApprovalPolicyControl', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('issues only the bounded draft policy and remains accessible', async () => {
    const { container } = render(<AgentApprovalPolicyControl {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add draft policy' }))
    fireEvent.change(
      screen.getByLabelText(/Why this agent may stop requiring per-draft approval/),
      { target: { value: 'Reviewed evidence supports bounded informational drafts.' } },
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Enable bounded draft policy' }))

    await waitFor(() => expect(issue).toHaveBeenCalledOnce())
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        agentIdentityId: 'agent_1',
        policyKey: 'support-primary-operational-update-drafts',
        maxTitleChars: 160,
        maxBodyChars: 4000,
        outcomeObservationIds: ['outcome_1'],
      }),
    )
    expect(issue.mock.calls[0]?.[0]).not.toHaveProperty('publish')
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('issues a separately bounded private support-draft policy', async () => {
    const props = {
      ...baseProps,
      identity: {
        ...baseProps.identity,
        accessCapabilities: ['updates:draft', 'support:draft'],
      },
    }
    const { container } = render(<AgentApprovalPolicyControl {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add draft policy' }))
    fireEvent.click(screen.getByLabelText(/Internal support-request draft/))
    fireEvent.change(
      screen.getByLabelText(/Why this agent may stop requiring per-draft approval/),
      { target: { value: 'Reviewed support outcomes justify private drafting.' } },
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Enable bounded draft policy' }))

    await waitFor(() => expect(issueSupport).toHaveBeenCalledOnce())
    expect(issueSupport).toHaveBeenCalledWith(
      expect.objectContaining({
        policyKey: 'support-primary-support-request-drafts',
        maxSubjectChars: 200,
        maxBodyChars: 20000,
        outcomeObservationIds: ['outcome_1'],
      }),
    )
    expect(issue).not.toHaveBeenCalled()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('surfaces active policy bounds and supports explicit revocation', async () => {
    render(
      <AgentApprovalPolicyControl
        {...baseProps}
        policies={[
          {
            id: 'grant_1',
            policyKey: 'support-primary-operational-update-drafts',
            actionName: 'pathfinder.create_update_draft',
            capability: 'updates:draft',
            issueReason: 'Reviewed evidence supports bounded informational drafts.',
            maxUses: 10,
            useCount: 2,
            expiresAt: null,
            revokedAt: null,
            revokeReason: null,
            state: 'ACTIVE',
            constraints: {
              contractVersion: 1,
              effect: 'DRAFT_ONLY',
              maxTitleChars: 120,
              maxBodyChars: 2000,
            },
            _count: { consumptions: 2 },
            authorityEvidence: [
              {
                createdAt: new Date('2030-01-01T10:05:00.000Z'),
                outcomeObservation: baseProps.outcomeObservations[0]!,
              },
            ],
          },
        ]}
      />,
    )
    expect(screen.getByText(/Title ≤ 120; body ≤ 2000/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke policy' }))
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        approvalGrantId: 'grant_1',
        reason: 'Revoked by the founder from the Agent workspace.',
      }),
    )
  })

  it('issues a NOTES-only intake proposal policy without apply or publication authority', async () => {
    const props = {
      ...baseProps,
      identity: { ...baseProps.identity, accessCapabilities: ['intake:draft'] },
    }
    const { container } = render(<AgentApprovalPolicyControl {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add draft policy' }))
    fireEvent.change(
      screen.getByLabelText(/Why this agent may stop requiring per-draft approval/),
      { target: { value: 'Reviewed onboarding outcomes justify notes-only proposals.' } },
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Enable bounded draft policy' }))

    await waitFor(() => expect(issueIntake).toHaveBeenCalledOnce())
    expect(issueIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        policyKey: 'support-primary-intake-notes-proposals',
        maxNotesChars: 20000,
        outcomeObservationIds: ['outcome_1'],
      }),
    )
    expect(issue).not.toHaveBeenCalled()
    expect(issueSupport).not.toHaveBeenCalled()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('keeps policy issuance unavailable until exact outcome evidence exists', () => {
    render(<AgentApprovalPolicyControl {...baseProps} outcomeObservations={[]} />)
    expect(screen.getByText(/No reviewed outcome observations exist/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add draft policy' })).toHaveProperty(
      'disabled',
      true,
    )
  })
})
