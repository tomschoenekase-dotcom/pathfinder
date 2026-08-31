/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { markFounderBriefingReviewed: { mutate: mocks.mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { FounderBriefingReviewForm } from './FounderBriefingReviewForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('FounderBriefingReviewForm', () => {
  beforeEach(() => {
    mocks.mutate.mockReset()
    mocks.refresh.mockReset()
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('records the exact server snapshot cursor and never requests execution', async () => {
    mocks.mutate.mockResolvedValue({ executionTriggered: false, replayed: false })
    render(
      <FounderBriefingReviewForm
        reviewedThrough={new Date('2026-08-22T12:00:00.000Z')}
        previousReviewedThrough={new Date('2026-08-22T11:00:00.000Z')}
        briefingSchemaVersion={1}
        hasUnreviewedChanges
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mark briefing reviewed' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      reviewedThrough: '2026-08-22T12:00:00.000Z',
      expectedPreviousReviewedThrough: '2026-08-22T11:00:00.000Z',
      briefingSchemaVersion: 1,
    })
    expect((await screen.findByRole('status')).textContent).toContain('No queue item was resolved')
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('fails closed with refresh guidance when the checkpoint cannot be confirmed', async () => {
    mocks.mutate.mockRejectedValue(new Error('conflict'))
    render(
      <FounderBriefingReviewForm
        reviewedThrough={new Date('2026-08-22T12:00:00.000Z')}
        previousReviewedThrough={null}
        briefingSchemaVersion={1}
        hasUnreviewedChanges={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mark briefing reviewed' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Refresh'))
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
