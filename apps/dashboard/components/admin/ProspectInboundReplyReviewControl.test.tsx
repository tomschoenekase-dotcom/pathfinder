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
    mocks.review.mockResolvedValue({ review: { id: 'review-1' }, replayed: false })
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
    expect((await axe.run(container)).violations).toEqual([])
  })
})
