/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProspectContactabilityReview } from './ProspectContactabilityReview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: { reviewProspectContactReadiness: { mutate: mocks.mutate } },
  }),
}))

describe('ProspectContactabilityReview', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('requires nonempty evidence while allowing evidence-only re-review', () => {
    render(
      <ProspectContactabilityReview
        contactId="contact-1"
        emailReadiness="REVIEW_REQUIRED"
        permissionState="REVIEW_REQUIRED"
      />,
    )

    const button = screen.getByRole('button', { name: 'Record contact review' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Human review evidence'), {
      target: { value: 'Refreshed the evidence without changing the recorded states.' },
    })
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('records only the human review and confirms that no message was sent', async () => {
    mocks.mutate.mockResolvedValueOnce({ id: 'contact-1' })
    render(
      <ProspectContactabilityReview
        contactId="contact-1"
        emailReadiness="REVIEW_REQUIRED"
        permissionState="REVIEW_REQUIRED"
      />,
    )

    fireEvent.change(screen.getByLabelText('Email verification status'), {
      target: { value: 'VALID' },
    })
    fireEvent.change(screen.getByLabelText('Permission basis'), {
      target: { value: 'LEGITIMATE_INTEREST_RECORDED' },
    })
    fireEvent.change(screen.getByLabelText('Human review evidence'), {
      target: { value: '  Public contact page and venue role reviewed.  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record contact review' }))

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        contactId: 'contact-1',
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        evidence: 'Public contact page and venue role reviewed.',
      }),
    )
    expect((await screen.findByRole('status')).textContent).toBe(
      'Contact readiness review recorded. No draft, campaign, batch, queue, or email was created.',
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('keeps suppressed contacts outside the readiness workflow', () => {
    render(
      <ProspectContactabilityReview
        contactId="contact-1"
        emailReadiness="INVALID"
        permissionState="PROHIBITED"
        disabledReason="This contact is suppressed."
      />,
    )

    expect(screen.getByText('This contact is suppressed.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Record contact review' })).toBeNull()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(
      <ProspectContactabilityReview
        contactId="contact-1"
        emailReadiness="REVIEW_REQUIRED"
        permissionState="REVIEW_REQUIRED"
      />,
    )

    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(result.violations).toEqual([])
  })

  it('shows a failed review and permits a corrected retry', async () => {
    mocks.mutate
      .mockRejectedValueOnce(new Error('The contact is suppressed.'))
      .mockResolvedValueOnce({ id: 'contact-1' })
    render(
      <ProspectContactabilityReview
        contactId="contact-1"
        emailReadiness="REVIEW_REQUIRED"
        permissionState="REVIEW_REQUIRED"
      />,
    )

    const evidence = screen.getByLabelText('Human review evidence')
    fireEvent.change(evidence, { target: { value: 'First review attempt.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record contact review' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The contact is suppressed.')

    fireEvent.change(evidence, { target: { value: 'Corrected review evidence.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record contact review' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2))
    expect((await screen.findByRole('status')).textContent).toContain(
      'No draft, campaign, batch, queue, or email was created.',
    )
  })
})
