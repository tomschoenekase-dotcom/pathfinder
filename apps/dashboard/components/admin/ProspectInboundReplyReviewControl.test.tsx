/* @vitest-environment jsdom */
import React from 'react'
import axe from 'axe-core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ review: vi.fn(), refresh: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { reviewProspectInboundReply: { mutate: mocks.review } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { ProspectInboundReplyReviewControl } from './ProspectInboundReplyReviewControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('ProspectInboundReplyReviewControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('records explicit positive-interest evidence without claiming a send or stage change', async () => {
    mocks.review.mockResolvedValue({
      review: { id: 'review-1' },
      replayed: false,
      deliveryAttempt: {
        id: 'attempt-1',
        status: 'DRAFT',
        recipientEmailSnapshot: 'owner@example.org',
        templateVersion: 'positive-interest-v1',
        subject: 'Your private Torchiko preview',
        textBody: 'Thanks for your interest. This is a saved draft.',
        createdAt: '2026-09-07T12:00:00.000Z',
      },
    })
    render(<ProspectInboundReplyReviewControl messageId="message-1" review={null} />)

    fireEvent.change(screen.getByLabelText('Disposition'), {
      target: { value: 'POSITIVE_INTEREST' },
    })
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'They asked to schedule a product conversation.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Classify reply' }))

    await waitFor(() => expect(mocks.review).toHaveBeenCalledOnce())
    expect(mocks.review).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      messageId: 'message-1',
      disposition: 'POSITIVE_INTEREST',
      reason: 'They asked to schedule a product conversation.',
    })
    expect((await screen.findByRole('status')).textContent).toContain(
      'No email was sent and no stage changed',
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(await screen.findByText('Invitation draft · DRAFT')).toBeTruthy()
    fireEvent.click(screen.getByText('Invitation draft · DRAFT'))
    expect(screen.getByText(/owner@example.org/u)).toBeTruthy()
    expect(screen.getByText('Thanks for your interest. This is a saved draft.')).toBeTruthy()
    expect(screen.getByText('Draft only · nothing was sent.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send/iu })).toBeNull()
  })

  it('restores the immutable invitation draft after a page reload', () => {
    render(
      <ProspectInboundReplyReviewControl
        messageId="message-1"
        review={null}
        deliveryAttempt={{
          id: 'attempt-1',
          status: 'DRAFT',
          recipientEmailSnapshot: 'owner@example.org',
          templateVersion: 'positive-interest-v1',
          subject: 'Your private Torchiko preview',
          textBody: 'Saved draft body.',
          createdAt: '2026-09-07T12:00:00.000Z',
        }}
      />,
    )
    expect(screen.getByText('Invitation draft · DRAFT')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send/iu })).toBeNull()
  })

  it('labels a retained draft as historical when the current review is no longer positive', () => {
    render(
      <ProspectInboundReplyReviewControl
        messageId="message-1"
        review={{
          id: 'review-2',
          disposition: 'NOT_INTERESTED',
          reason: 'They later declined.',
          reviewerId: 'founder-1',
          revision: 2,
          createdAt: '2026-09-07T13:00:00.000Z',
        }}
        deliveryAttempt={{
          id: 'attempt-1',
          status: 'DRAFT',
          recipientEmailSnapshot: 'owner@example.org',
          templateVersion: 'positive-interest-v1',
          subject: 'Private preview',
          textBody: 'Historical draft body.',
          createdAt: '2026-09-07T12:00:00.000Z',
        }}
      />,
    )
    fireEvent.click(screen.getByText('Historical invitation draft · DRAFT'))
    expect(screen.getByText(/not send eligible/iu)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /send/iu })).toBeNull()
  })

  it('shows a confirmed negative re-review as historical before router refresh resolves', async () => {
    mocks.review.mockResolvedValue({
      review: { disposition: 'NOT_INTERESTED' },
      replayed: false,
      deliveryAttempt: null,
    })
    render(
      <ProspectInboundReplyReviewControl
        messageId="message-1"
        review={{
          id: 'review-1',
          disposition: 'POSITIVE_INTEREST',
          reason: 'They initially asked for a preview.',
          reviewerId: 'founder-1',
          revision: 1,
          createdAt: '2026-09-07T12:00:00.000Z',
        }}
        deliveryAttempt={{
          id: 'attempt-1',
          status: 'DRAFT',
          recipientEmailSnapshot: 'owner@example.org',
          templateVersion: 'positive-interest-v1',
          subject: 'Preview',
          textBody: 'Draft.',
          createdAt: '2026-09-07T12:01:00.000Z',
        }}
      />,
    )
    fireEvent.change(screen.getByLabelText('Disposition'), { target: { value: 'NOT_INTERESTED' } })
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'They declined.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record a new review' }))
    expect(await screen.findByText('Historical invitation draft · DRAFT')).toBeTruthy()
  })

  it('synchronizes a retained draft supplied by a refreshed server render', () => {
    const { rerender } = render(
      <ProspectInboundReplyReviewControl messageId="message-1" review={null} />,
    )
    expect(screen.queryByText(/Invitation draft · DRAFT/u)).toBeNull()
    rerender(
      <ProspectInboundReplyReviewControl
        messageId="message-1"
        review={null}
        deliveryAttempt={{
          id: 'attempt-1',
          status: 'DRAFT',
          recipientEmailSnapshot: 'owner@example.org',
          templateVersion: 'positive-interest-v1',
          subject: 'Preview',
          textBody: 'Reloaded draft.',
          createdAt: '2026-09-07T12:01:00.000Z',
        }}
      />,
    )
    expect(screen.getByText('Invitation draft · DRAFT')).toBeTruthy()
  })

  it('does not show a late mutation result after an A to B to A scope cycle', async () => {
    let resolveReview!: (value: unknown) => void
    mocks.review.mockReturnValue(
      new Promise((resolve) => {
        resolveReview = resolve
      }),
    )
    const { rerender } = render(
      <ProspectInboundReplyReviewControl messageId="message-1" review={null} />,
    )
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'First message.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Classify reply' }))
    rerender(<ProspectInboundReplyReviewControl messageId="message-2" review={null} />)
    rerender(<ProspectInboundReplyReviewControl messageId="message-1" review={null} />)
    resolveReview({
      review: { disposition: 'POSITIVE_INTEREST' },
      replayed: false,
      deliveryAttempt: {
        id: 'attempt-old',
        status: 'DRAFT',
        recipientEmailSnapshot: 'old@example.org',
        templateVersion: 'positive-interest-v1',
        subject: 'Old',
        textBody: 'Old draft.',
        createdAt: '2026-09-07T12:01:00.000Z',
      },
    })
    await waitFor(() => expect(mocks.review).toHaveBeenCalledOnce())
    expect(screen.queryByText(/Invitation draft · DRAFT/u)).toBeNull()
    expect(screen.queryByText('Old draft.')).toBeNull()
  })

  it('preserves the request lock through a same-message authoritative prop refresh', async () => {
    let resolveReview!: (value: unknown) => void
    mocks.review.mockReturnValue(
      new Promise((resolve) => {
        resolveReview = resolve
      }),
    )
    const { rerender } = render(
      <ProspectInboundReplyReviewControl messageId="message-1" review={null} />,
    )
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'Pending review.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Classify reply' }))
    expect((screen.getByRole('button', { name: 'Recording…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    rerender(
      <ProspectInboundReplyReviewControl
        messageId="message-1"
        review={null}
        deliveryAttempt={{
          id: 'attempt-refreshed',
          status: 'DRAFT',
          recipientEmailSnapshot: 'owner@example.org',
          templateVersion: 'positive-interest-v1',
          subject: 'Preview',
          textBody: 'Refreshed.',
          createdAt: '2026-09-07T12:01:00.000Z',
        }}
      />,
    )
    expect((screen.getByRole('button', { name: 'Recording…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recording…' }))
    expect(mocks.review).toHaveBeenCalledOnce()
    resolveReview({ review: { disposition: 'OTHER' }, replayed: false, deliveryAttempt: null })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Classify reply' })).toBeTruthy())
  })

  it('shows current human evidence and permits an append-only re-review', () => {
    render(
      <ProspectInboundReplyReviewControl
        messageId="message-1"
        review={{
          id: 'review-1',
          disposition: 'QUESTION_OR_OBJECTION',
          reason: 'They asked how visitor analytics are handled.',
          reviewerId: 'founder-1',
          revision: 2,
          createdAt: '2026-08-30T16:50:00.000Z',
        }}
      />,
    )

    expect(screen.getByText('Question or objection · v2')).toBeTruthy()
    expect(screen.getByText('They asked how visitor analytics are handled.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Record a new review' })).toBeTruthy()
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = render(
      <ProspectInboundReplyReviewControl messageId="message-1" review={null} />,
    )
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
