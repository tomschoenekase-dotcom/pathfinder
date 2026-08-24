/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  decideTriage: vi.fn(),
  decideInformationRequest: vi.fn(),
  decideCompletion: vi.fn(),
  decidePackageDraft: vi.fn(),
  decidePackageApproval: vi.fn(),
  decidePackageApplication: vi.fn(),
  query: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      recordApprovalDecision: { mutate: mocks.mutate },
      decideSupportTriageProposal: { mutate: mocks.decideTriage },
      decideSupportInformationRequestProposal: { mutate: mocks.decideInformationRequest },
      decideSupportCompletionProposal: { mutate: mocks.decideCompletion },
      decideSupportPackageDraftProposal: { mutate: mocks.decidePackageDraft },
      decideSupportPackageApprovalProposal: { mutate: mocks.decidePackageApproval },
      decideSupportPackageApplicationProposal: { mutate: mocks.decidePackageApplication },
      getApprovalRequest: { query: mocks.query },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
import { ApprovalDecisionForm } from './ApprovalDecisionForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('ApprovalDecisionForm', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('records a human decision while explicitly reporting no execution', async () => {
    mocks.mutate.mockResolvedValue({ decision: { id: 'decision_1' }, executionTriggered: false })
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="publish update"
      />,
    )
    expect(screen.getByText(/does not run, apply, publish, retry, or enqueue/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('APPROVED'))
    fireEvent.change(screen.getByLabelText('Decision reason (optional)'), {
      target: { value: 'Evidence reviewed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record approved decision' }))
    await waitFor(() =>
      expect(screen.getByText('APPROVED decision recorded. No action was executed.')).toBeTruthy(),
    )
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
      reason: 'Evidence reviewed',
    })
  })

  it('serializes writes and requires a state refresh after an ambiguous outcome', async () => {
    let reject!: (reason: unknown) => void
    mocks.mutate.mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      }),
    )
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="publish update"
      />,
    )
    const submit = screen.getByRole('button', { name: 'Record rejected decision' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    reject(new Error('network'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be confirmed'),
    )
    expect(screen.getByRole('button', { name: 'Refresh approval state' })).toBeTruthy()
  })

  it('turns an approved triage proposal into exact one-shot authority without executing it', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222',
    )
    mocks.decideTriage.mockResolvedValue({
      decision: { id: 'decision_1' },
      approvalGrant: { id: 'grant_1' },
      executionTriggered: false,
    })
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="pathfinder.apply_support_triage"
      />,
    )
    expect(screen.getByText(/issues exact one-shot authority/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('APPROVED'))
    fireEvent.click(screen.getByRole('button', { name: 'Record approved decision' }))
    await waitFor(() =>
      expect(screen.getByText(/Exact one-shot triage authority was issued/)).toBeTruthy(),
    )
    expect(mocks.decideTriage).toHaveBeenCalledWith({
      operationId: '22222222-2222-4222-8222-222222222222',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
    })
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('makes founder-approved client contact authority explicit without executing contact', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333',
    )
    mocks.decideInformationRequest.mockResolvedValue({
      decision: { id: 'decision_1' },
      approvalGrant: { id: 'grant_1' },
      executionTriggered: false,
    })
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="pathfinder.apply_support_information_request"
      />,
    )
    expect(screen.getByText(/reviewed in-app client-visible prompt/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('APPROVED'))
    fireEvent.click(screen.getByRole('button', { name: 'Record approved decision' }))
    await waitFor(() =>
      expect(screen.getByText(/no message was sent and no lifecycle state changed/)).toBeTruthy(),
    )
    expect(mocks.decideInformationRequest).toHaveBeenCalledWith({
      operationId: '33333333-3333-4333-8333-333333333333',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
    })
  })

  it('issues exact completion authority without contacting the client', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '44444444-4444-4444-8444-444444444444',
    )
    mocks.decideCompletion.mockResolvedValue({
      decision: { id: 'decision_1' },
      approvalGrant: { id: 'grant_1' },
      executionTriggered: false,
    })
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="pathfinder.apply_support_completion"
      />,
    )
    expect(screen.getByText(/reviewed in-app client-visible completion message/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('APPROVED'))
    fireEvent.click(screen.getByRole('button', { name: 'Record approved decision' }))
    await waitFor(() =>
      expect(screen.getByText(/no message was sent and no lifecycle state changed/)).toBeTruthy(),
    )
    expect(mocks.decideCompletion).toHaveBeenCalledWith({
      operationId: '44444444-4444-4444-8444-444444444444',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
    })
  })

  it('issues exact package-DRAFT authority without creating or applying content', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '55555555-5555-4555-8555-555555555555',
    )
    mocks.decidePackageDraft.mockResolvedValue({
      decision: { id: 'decision_1' },
      approvalGrant: { id: 'grant_1' },
      executionTriggered: false,
    })
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="pathfinder.apply_support_package_draft"
      />,
    )
    expect(screen.getByText(/create and link only the reviewed V3 package DRAFT/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('APPROVED'))
    fireEvent.click(screen.getByRole('button', { name: 'Record approved decision' }))
    await waitFor(() =>
      expect(
        screen.getByText(/no package was created, approved, applied, or published/),
      ).toBeTruthy(),
    )
    expect(mocks.decidePackageDraft).toHaveBeenCalledWith({
      operationId: '55555555-5555-4555-8555-555555555555',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
    })
  })

  it('issues exact package approval authority without approving or applying during the decision', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '66666666-6666-4666-8666-666666666666',
    )
    mocks.decidePackageApproval.mockResolvedValue({
      decision: { id: 'decision_1' },
      approvalGrant: { id: 'grant_1' },
      executionTriggered: false,
    })
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="pathfinder.apply_support_package_approval"
      />,
    )
    expect(screen.getByText(/reviewed, unchanged support-linked package/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('APPROVED'))
    fireEvent.click(screen.getByRole('button', { name: 'Record approved decision' }))
    await waitFor(() =>
      expect(screen.getByText(/package was not yet approved, applied, published/)).toBeTruthy(),
    )
    expect(mocks.decidePackageApproval).toHaveBeenCalledWith({
      operationId: '66666666-6666-4666-8666-666666666666',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
    })
  })

  it('warns that later package application mutates current content while the decision stays inert', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '88888888-8888-4888-8888-888888888888',
    )
    mocks.decidePackageApplication.mockResolvedValue({
      decision: { id: 'decision_1' },
      approvalGrant: { id: 'grant_1' },
      executionTriggered: false,
    })
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="pathfinder.apply_support_package_application"
      />,
    )
    expect(
      screen.getByText(/apply this unchanged APPROVED package to current venue content/),
    ).toBeTruthy()
    expect(screen.getByText(/may become visitor-visible immediately/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('APPROVED'))
    fireEvent.click(screen.getByRole('button', { name: 'Record approved decision' }))
    await waitFor(() =>
      expect(screen.getByText(/no content was changed.*no customer was contacted/)).toBeTruthy(),
    )
    expect(mocks.decidePackageApplication).toHaveBeenCalledWith({
      operationId: '88888888-8888-4888-8888-888888888888',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
    })
  })
})
