/* @vitest-environment jsdom */
import React from 'react'
import axe from 'axe-core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), review: vi.fn(), refresh: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      prepareProspectEmailAttachmentRetention: { mutate: mocks.prepare },
      reviewProspectEmailAttachmentRetention: { mutate: mocks.review },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { ProspectAttachmentRetentionControl } from './ProspectAttachmentRetentionControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('ProspectAttachmentRetentionControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('prepares metadata-only review without requesting provider execution', async () => {
    mocks.prepare.mockResolvedValue({ request: { id: 'request-1' }, replayed: false })
    render(
      <ProspectAttachmentRetentionControl
        emailMessageId="message-1"
        providerAttachmentId="attachment-1"
        request={null}
      />,
    )
    fireEvent.change(screen.getByLabelText('Business-record category'), {
      target: { value: 'FLOOR_PLAN_OR_MAP' },
    })
    fireEvent.change(screen.getByLabelText('Why this attachment may be useful'), {
      target: { value: 'Needed for the visitor guide.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Prepare retention review' }))

    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1))
    expect(mocks.prepare).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      emailMessageId: 'message-1',
      providerAttachmentId: 'attachment-1',
      category: 'FLOOR_PLAN_OR_MAP',
      purpose: 'Needed for the visitor guide.',
    })
    expect(screen.getByRole('status').textContent).toContain('No attachment bytes were downloaded')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('records approval as future import authority and states that no import occurred', async () => {
    mocks.review.mockResolvedValue({ request: { status: 'APPROVED_FOR_IMPORT' }, replayed: false })
    render(
      <ProspectAttachmentRetentionControl
        emailMessageId="message-1"
        providerAttachmentId="attachment-1"
        request={{
          id: '33333333-3333-4333-8333-333333333333',
          status: 'AWAITING_REVIEW',
          category: 'FLOOR_PLAN_OR_MAP',
          purpose: 'Needed for the visitor guide.',
          reviewReason: null,
        }}
      />,
    )
    fireEvent.change(screen.getByLabelText('Decision reason'), {
      target: { value: 'Useful source material.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Approve for separate import' }))

    await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1))
    expect(mocks.review).toHaveBeenCalledWith({
      requestId: '33333333-3333-4333-8333-333333333333',
      reviewOperationId: '11111111-1111-4111-8111-111111111111',
      decision: 'APPROVE_FOR_IMPORT',
      reason: 'Useful source material.',
    })
    expect(screen.getByRole('status').textContent).toContain('No bytes were downloaded or retained')
  })

  it('renders a terminal source-only decision with no action controls', () => {
    render(
      <ProspectAttachmentRetentionControl
        emailMessageId="message-1"
        providerAttachmentId="attachment-1"
        request={{
          id: '33333333-3333-4333-8333-333333333333',
          status: 'DECLINED_SOURCE_ONLY',
          category: 'BROCHURE',
          purpose: 'Considered for archival reference.',
          reviewReason: 'Gmail remains sufficient.',
        }}
      />,
    )
    expect(screen.getByText('Declined Source Only')).toBeTruthy()
    expect(screen.getByText(/No provider or storage action was executed/iu)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has no detectable accessibility violations in the pending review state', async () => {
    const { container } = render(
      <ProspectAttachmentRetentionControl
        emailMessageId="message-1"
        providerAttachmentId="attachment-1"
        request={{
          id: '33333333-3333-4333-8333-333333333333',
          status: 'AWAITING_REVIEW',
          category: 'FLOOR_PLAN_OR_MAP',
          purpose: 'Needed for the visitor guide.',
          reviewReason: null,
        }}
      />,
    )
    expect((await axe.run(container)).violations).toEqual([])
  })
})
