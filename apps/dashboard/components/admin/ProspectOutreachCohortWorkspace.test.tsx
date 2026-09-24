/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProspectOutreachCohortWorkspace } from './ProspectOutreachCohortWorkspace'
import type { OutreachReviewDocument } from './ProspectOutreachReviewDocument'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const calls = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  acknowledge: vi.fn(),
  control: vi.fn(),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      listProspectOutreachCohorts: { query: calls.list },
      readProspectOutreachCohort: { query: calls.read },
      acknowledgeProspectOutreachReview: { mutate: calls.acknowledge },
      controlProspectOutreachCohort: { mutate: calls.control },
    },
  }),
}))
function review(): OutreachReviewDocument {
  return {
    cohortId: 'SYN-GROUP',
    name: 'Synthetic exact group',
    question: 'An exact no-send fixture.',
    count: 50,
    readyForHumanReview: 50,
    reviewHash: 'a'.repeat(64),
    sender: 'tomschoenekase@torchiko.com',
    SEND_AUTHORIZED: false,
    status: 'DRAFT',
    preparationAvailable: true,
    rows: Array.from({ length: 50 }, (_, i) => ({
      memberId: `m${i}`,
      organizationId: `o${i}`,
      venueId: `v${i}`,
      name: `Synthetic venue ${i + 1}`,
      state: 'REVIEW_REQUIRED',
      recipient: `fixture${i}@example.invalid`,
      reasons: [],
      nativeRead: 'READ',
      exactSelectedDraft: true,
      stale: false,
      suppression: { blocked: false, reasons: [] },
      outreachState: 'DRAFT_REVIEW',
      correspondenceState: 'NO_RETAINED_HISTORY',
      sourceState: 'SYNTHETIC',
      draft: {
        id: `d${i}`,
        version: 1,
        contentHash: 'b'.repeat(64),
        subject: `Synthetic individual subject ${i + 1}`,
        body: `Exact synthetic body ${i + 1}. <img src=x onerror=alert(1)>`,
        state: 'DRAFT_REVIEW',
        generatedBy: 'SYNTHETIC_RENDER_FIXTURE_NOT_A_MODEL_RUN',
      },
      threadCoverage: [],
      operational: null,
    })),
  }
}
beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset()
  calls.list.mockResolvedValue({
    items: [{ cohortId: 'SYN-GROUP', name: 'Synthetic exact group', count: 50 }],
    nextCursor: null,
  })
  calls.read.mockResolvedValue(review())
  calls.acknowledge.mockResolvedValue({ receiptId: 'synthetic-read-receipt' })
  calls.control.mockResolvedValue({ status: 'PAUSED', receiptId: 'synthetic-control-receipt' })
})
afterEach(cleanup)
async function openGroup() {
  render(<ProspectOutreachCohortWorkspace />)
  fireEvent.click(await screen.findByRole('button', { name: 'Synthetic exact group · 50 records' }))
  await screen.findByText('Synthetic individual subject 50')
}
describe('normal outreach preparation controls with bounded synthetic transport', () => {
  it('shows real loading instead of a false empty result; an unavailable list remains an error', async () => {
    let reject!: (reason: Error) => void
    calls.list.mockReturnValue(
      new Promise((_resolve, failure) => {
        reject = failure
      }),
    )
    render(<ProspectOutreachCohortWorkspace />)
    expect(screen.getByText('Loading retained preparation groups…')).toBeTruthy()
    expect(screen.queryByText(/No preparation group was returned/)).toBeNull()
    reject(Error('Native listing disconnected'))
    expect(await screen.findByText(/Native listing disconnected/)).toBeTruthy()
    expect(screen.queryByText(/No preparation group was returned/)).toBeNull()
  })
  it('shows all fifty exact bodies, escapes text, links original venues and acknowledges only the displayed fingerprint', async () => {
    await openGroup()
    expect(document.querySelectorAll('[data-outreach-member]')).toHaveLength(50)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button', { name: /^send/i })).toBeNull()
    expect(
      screen.getAllByRole('link', { name: 'Open native venue' })[49]?.getAttribute('href'),
    ).toBe('/admin/prospects/o49?venue=v49')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Record this exact read acknowledgement' }))
    await waitFor(() =>
      expect(calls.acknowledge).toHaveBeenCalledWith({
        cohortId: 'SYN-GROUP',
        expectedReviewHash: 'a'.repeat(64),
        expectedCount: 50,
        acknowledgement: 'I reviewed these exact messages and holds. This is not sending approval.',
      }),
    )
    expect(await screen.findByText(/No meaning or send approval was created/)).toBeTruthy()
  })
  it('retries an unknown preparation-state response with the same exact request, not a new key', async () => {
    calls.control.mockRejectedValueOnce(Error('Response lost after native commit'))
    await openGroup()
    fireEvent.change(screen.getByLabelText('Reason for this preparation-state change'), {
      target: { value: 'Pause this synthetic group until its exact context is reviewed.' },
    })
    const pause = screen.getByRole('button', { name: 'Pause preparation' })
    fireEvent.click(pause)
    fireEvent.click(pause)
    const retry = await screen.findByRole('button', { name: 'Retry the exact pause request' })
    expect(calls.control).toHaveBeenCalledTimes(1)
    const first = calls.control.mock.calls[0]![0]
    calls.read.mockResolvedValue({ ...review(), status: 'PAUSED', preparationAvailable: false })
    fireEvent.click(retry)
    await waitFor(() => expect(calls.control).toHaveBeenCalledTimes(2))
    expect(calls.control.mock.calls[1]![0]).toEqual(first)
    expect(first.expectedReviewHash).toBe('a'.repeat(64))
    expect(first.action).toBe('pause')
    expect(await screen.findByText(/Preparation state retained: PAUSED/)).toBeTruthy()
    expect(screen.getByText(/Native group state: PAUSED/)).toBeTruthy()
  })
  it('does not display unavailable current review as an empty or approved group', async () => {
    calls.read.mockRejectedValue(Error('Current exact native context unavailable'))
    render(<ProspectOutreachCohortWorkspace />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Synthetic exact group · 50 records' }),
    )
    expect(await screen.findByText('Current exact native context unavailable')).toBeTruthy()
    expect(document.querySelectorAll('[data-outreach-member]')).toHaveLength(0)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
