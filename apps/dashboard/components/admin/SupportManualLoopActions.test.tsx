/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const preview = vi.fn()
const complete = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      requestSupportInformation: { mutate: vi.fn() },
      getSupportCompletionPreview: { query: preview },
      completeSupportRequest: { mutate: complete },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { SupportManualLoopActions } from './SupportManualLoopActions'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SupportManualLoopActions completion review facts', () => {
  it('shows declined facts before confirmation and preserves the exact completion body', async () => {
    preview.mockResolvedValue({
      outcome: 'RESOLVED',
      fulfillmentDigest: 'a'.repeat(64),
      expectedVersion: 4,
      reviewedDeclines: [
        {
          proposalSummary: 'Replace the accessible entrance directions.',
          reviewNote: 'The evidence did not establish a permanent route.',
        },
      ],
    })
    render(
      <SupportManualLoopActions
        tenantId="tenant-1"
        venueId="venue-1"
        requestId="request-1"
        expectedVersion={4}
        currentStatus="IN_REVIEW"
        missingInformation={[]}
      />,
    )
    const body = screen.getByLabelText('Completion message to client')
    fireEvent.change(body, { target: { value: 'We reviewed the requested guidance.\nThank you.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review completion outcome' }))

    expect(await screen.findByText('Request resolved')).toBeTruthy()
    const facts = screen.getByText('Declined changes')
    const confirmation = screen.getByLabelText(/I confirm this conversation is complete/)
    expect(
      facts.compareDocumentPosition(confirmation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    fireEvent.click(confirmation)
    fireEvent.click(screen.getByRole('button', { name: 'Complete support request' }))
    await waitFor(() => expect(complete).toHaveBeenCalledOnce())
    expect(complete.mock.calls[0]?.[0].body).toBe('We reviewed the requested guidance.\nThank you.')
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      expectedCompletionOutcome: 'RESOLVED',
      expectedFulfillmentDigest: 'a'.repeat(64),
    })
  })

  it('does not invent declined facts for an older preview response', async () => {
    preview.mockResolvedValue({
      outcome: 'NO_CHANGE',
      fulfillmentDigest: 'b'.repeat(64),
      expectedVersion: 4,
    })
    render(
      <SupportManualLoopActions
        tenantId="tenant-1"
        venueId="venue-1"
        requestId="request-1"
        expectedVersion={4}
        currentStatus="IN_REVIEW"
        missingInformation={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Completion message to client'), {
      target: { value: 'No changes were needed.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review completion outcome' }))
    expect(await screen.findByText('No change needed')).toBeTruthy()
    expect(screen.queryByText('Declined changes')).toBeNull()
  })
})
