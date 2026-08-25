// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mutate, refresh } = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: { executeApprovedCustomerInvitation: { mutate } },
  }),
}))

import { CustomerAccessApprovalContext } from './CustomerAccessApprovalContext'

const updatedAt = new Date('2026-08-25T14:00:00.000Z')

function request(status: string) {
  return {
    id: 'access-1',
    targetEmail: 'member@example.test',
    requestedRole: 'MEMBER',
    status,
    supportRequestId: 'support-1',
    sourceSupportMessageId: 'message-1',
    providerInvitationId: null,
    updatedAt,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mutate.mockResolvedValue({
    status: 'INVITED',
    providerInvitationId: 'invite-1',
    replayed: false,
    membershipCreatedLocally: false,
  })
})

describe('customer access approval context', () => {
  it('keeps unapproved requests provider-dark', () => {
    render(
      <CustomerAccessApprovalContext
        tenantId="tenant-1"
        venueId="venue-1"
        request={request('AWAITING_APPROVAL')}
      />,
    )
    expect(screen.getByText('No invitation sent')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /invitation/i })).toBeNull()
  })

  it('exposes a mobile-sized explicit execution action only after approval', async () => {
    render(
      <CustomerAccessApprovalContext
        tenantId="tenant-1"
        venueId="venue-1"
        request={request('APPROVED')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send approved invitation' }))
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: 'access-1',
        expectedUpdatedAt: updatedAt,
      }),
    )
    expect(
      await screen.findByText(
        'The approved provider invitation was sent and its exact provider evidence was recorded.',
      ),
    ).toBeTruthy()
    expect(refresh).toHaveBeenCalled()
  })

  it('labels ambiguous outcomes for explicit reconciliation', () => {
    render(
      <CustomerAccessApprovalContext
        tenantId="tenant-1"
        venueId="venue-1"
        request={request('RECONCILIATION_REQUIRED')}
      />,
    )
    expect(screen.getByRole('button', { name: 'Reconcile approved invitation' })).toBeTruthy()
  })
})
