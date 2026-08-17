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
  it('shares staff answers with client-safe language and no implementation identifiers', async () => {
    mocks.mutate.mockResolvedValue({ id: 'run-1' })
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Staff questionnaire'))
    fireEvent.change(screen.getByLabelText('Interview name'), {
      target: { value: 'Staff interview' },
    })
    fireEvent.change(screen.getAllByLabelText('Written answer')[0]!, {
      target: { value: 'Hours are nine to five.' },
    })
    fireEvent.click(screen.getAllByLabelText('Explicitly skip')[1]!)
    fireEvent.click(screen.getAllByLabelText('Redact')[2]!)
    fireEvent.click(screen.getByLabelText(STAFF_INTERVIEW_CONSENT_TEXT))
    fireEvent.click(screen.getByRole('button', { name: 'Share staff answers' }))
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        venueId: 'venue-1',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
            {
              questionId: 'executive.priorities',
              privacy: 'PUBLIC_CANDIDATE',
              skipped: true,
              redacted: false,
              uncertain: false,
              confidence: 0.8,
            },
            {
              questionId: 'executive.internal-risks',
              privacy: 'INTERNAL_CONTEXT',
              skipped: false,
              redacted: true,
              uncertain: false,
              confidence: 0.8,
            },
          ],
        },
      }),
    )
    expect(await screen.findByText(/Information received/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /proposal|package|handoff|manifest|hash|quarantin/iu,
    )
  })

  it('does not offer a public classification for private-by-default questions', () => {
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Staff questionnaire'))
    fireEvent.change(screen.getByLabelText('Staff role'), { target: { value: 'OPERATIONS' } })
    const classifications = screen.getAllByLabelText('Privacy', {
      selector: 'select',
    })
    const classification = classifications.at(-1) as HTMLSelectElement
    expect(Array.from(classification.options).map((option) => option.value)).toEqual(['PRIVATE'])
  })

  it('keeps package identity and operator workflow language out of client history', () => {
    render(
      <IntakeProposalWorkspace
        venueId="venue-1"
        proposals={[
          {
            id: 'intake-secret-id',
            sourceKind: 'WEBSITE',
            status: 'AWAITING_REVIEW',
            displayName: 'Venue website',
            websiteUri: 'https://example.com',
            interviewRole: null,
            createdAt: new Date('2026-08-10T12:00:00.000Z'),
            _count: { evidence: 8, events: 3 },
            packageHandoff: {
              packageDraftId: 'package-secret-id',
              createdAt: new Date('2026-08-10T13:00:00.000Z'),
            },
          },
        ]}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Information shared' })).toBeTruthy()
    expect(screen.getByText(/Prepared for Torchiko review/)).toBeTruthy()
    expect(screen.getByLabelText('Website name')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /package-secret-id|intake-secret-id|draft package|handoff|proposal history|evidence record/iu,
    )
  })

  it('fences same-tick duplicate submits and retains the request identity for an exact retry', async () => {
    let rejectFirst!: (error: Error) => void
    mocks.adminMutate
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockResolvedValueOnce({ id: 'run-admin' })
    render(<IntakeProposalWorkspace adminTenantId="tenant-1" venueId="venue-1" proposals={[]} />)
    fireEvent.change(screen.getByLabelText('Proposal name'), { target: { value: 'Venue site' } })
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://example.com' },
    })
    const submit = screen.getByRole('button', { name: 'Record website proposal' })
    fireEvent.click(submit)
    fireEvent.submit(submit.closest('form')!)
    expect(mocks.adminMutate).toHaveBeenCalledTimes(1)
    const firstRequestId = mocks.adminMutate.mock.calls[0]?.[0].requestId
    rejectFirst(new Error('Ambiguous response'))
    await screen.findByText(/Ambiguous response/)
    fireEvent.click(screen.getByRole('button', { name: 'Record website proposal' }))
    await waitFor(() => expect(mocks.adminMutate).toHaveBeenCalledTimes(2))
    expect(mocks.adminMutate.mock.calls[1]?.[0].requestId).toBe(firstRequestId)
  })

  it('serializes operator-assisted website intake through the platform-admin adapter', async () => {
    mocks.adminMutate.mockResolvedValue({ id: 'run-admin' })
    render(<IntakeProposalWorkspace adminTenantId="tenant-1" venueId="venue-1" proposals={[]} />)
    fireEvent.change(screen.getByLabelText('Proposal name'), { target: { value: 'Venue site' } })
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record website proposal' }))
    await waitFor(() =>
      expect(mocks.adminMutate).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: 'WEBSITE',
        displayName: 'Venue site',
        websiteUri: 'https://example.com',
      }),
    )
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
})
