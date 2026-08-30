/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  queue: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      prepareGuestAnswerAttributionEvaluation: { mutate: mocks.prepare },
      queueGuestAnswerAttributionEvaluation: { mutate: mocks.queue },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { GuestAnswerEvaluationPanel } from './GuestAnswerEvaluationPanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const request = {
  id: '11111111-1111-4111-8111-111111111111',
  guestChatTurnId: '22222222-2222-4222-8222-222222222222',
  answerHash: 'a'.repeat(64),
  evidenceSetHash: 'b'.repeat(64),
  status: 'STAGED' as const,
  attemptNumber: 0,
  providerDispatchedAt: null,
  resultAttributionId: null,
  lastErrorCode: null,
  createdAt: new Date('2026-08-25T00:00:00.000Z'),
}

const baseProps = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  requests: [request],
  readiness: { processEnabled: false, durableGlobalEnabled: false, tenantEnabled: false },
  executionEnabled: false,
}

describe('GuestAnswerEvaluationPanel', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('shows every default-off gate and disables provider queueing', () => {
    render(<GuestAnswerEvaluationPanel {...baseProps} />)
    expect(screen.getByText('Execution default-off')).toBeTruthy()
    expect(screen.getAllByText('Off')).toHaveLength(3)
    expect(
      (screen.getByRole('button', { name: 'Queue semantic review' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText(/cannot publish, repair content, or authorize a release/)).toBeTruthy()
  })

  it('stages an exact public turn without implying provider execution', async () => {
    mocks.prepare.mockResolvedValue({ request: { id: request.id } })
    render(<GuestAnswerEvaluationPanel {...baseProps} requests={[]} />)
    fireEvent.change(screen.getByLabelText('Completed public guest-turn UUID'), {
      target: { value: request.guestChatTurnId },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Stage exact evidence' }))
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
    expect(await screen.findByText(/No provider work was started/)).toBeTruthy()
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
