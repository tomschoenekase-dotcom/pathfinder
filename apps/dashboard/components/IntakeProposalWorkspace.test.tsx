/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { STAFF_INTERVIEW_CONSENT_TEXT } from '@pathfinder/contracts/staff-interview'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), adminMutate: vi.fn(), refresh: vi.fn() }))
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    intake: { createProposal: { mutate: mocks.mutate } },
    admin: { createIntakeProposal: { mutate: mocks.adminMutate } },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
import { IntakeProposalWorkspace } from './IntakeProposalWorkspace'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('IntakeProposalWorkspace', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })
  it('records a text interview as a draft-only proposal', async () => {
    mocks.mutate.mockResolvedValue({ id: 'run-1' })
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Text interview'))
    fireEvent.change(screen.getByLabelText('Proposal name'), {
      target: { value: 'Staff interview' },
    })
    fireEvent.change(screen.getByLabelText(/venue.s mission and purpose/u), {
      target: { value: 'Hours are nine to five.' },
    })
    fireEvent.click(screen.getByLabelText(STAFF_INTERVIEW_CONSENT_TEXT))
    fireEvent.click(screen.getByRole('button', { name: 'Record draft proposal' }))
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        venueId: 'venue-1',
        kind: 'INTERVIEW',
        displayName: 'Staff interview',
        submission: {
          role: 'EXECUTIVE',
          consentToUse: true,
          acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
          answers: [
            {
              questionId: 'executive.mission',
              text: 'Hours are nine to five.',
              privacy: 'PUBLIC_CANDIDATE',
              skipped: false,
              redacted: false,
              uncertain: false,
              confidence: 0.8,
            },
          ],
        },
      }),
    )
    expect(await screen.findByText(/Nothing was approved, applied, or published/)).toBeTruthy()
  })

  it('does not offer a public classification for private-by-default questions', () => {
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Text interview'))
    fireEvent.change(screen.getByLabelText('Interview role'), { target: { value: 'OPERATIONS' } })
    const classifications = screen.getAllByLabelText('Privacy classification', {
      selector: 'select',
    })
    const classification = classifications.at(-1) as HTMLSelectElement
    expect(Array.from(classification.options).map((option) => option.value)).toEqual(['PRIVATE'])
  })

  it('serializes operator-assisted website intake through the platform-admin adapter', async () => {
    mocks.adminMutate.mockResolvedValue({ id: 'run-admin' })
    render(<IntakeProposalWorkspace adminTenantId="tenant-1" venueId="venue-1" proposals={[]} />)
    fireEvent.change(screen.getByLabelText('Proposal name'), { target: { value: 'Venue site' } })
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record draft proposal' }))
    await waitFor(() =>
      expect(mocks.adminMutate).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        kind: 'WEBSITE',
        displayName: 'Venue site',
        websiteUri: 'https://example.com',
      }),
    )
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
})
