/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentOutcomeObservationForm } from './AgentOutcomeObservationForm'

const mutate = vi.fn()
const mutateTrustSignal = vi.fn()
const refresh = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      recordAgentRunOutcome: { mutate },
      recordAgentTrustSignal: { mutate: mutateTrustSignal },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('AgentOutcomeObservationForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('records explicit evidence without claiming execution or approval', async () => {
    mutate.mockResolvedValue({ id: 'outcome-1', replayed: false })
    render(<AgentOutcomeObservationForm tenantId="tenant-1" venueId="venue-1" agentRunId="run-1" />)

    fireEvent.change(screen.getByLabelText('Verdict'), { target: { value: 'MIXED' } })
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: ' Useful after correcting the estimate. ' },
    })
    fireEvent.change(screen.getByLabelText('Evidence reference (optional)'), {
      target: { value: ' decision-42 ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record evidence' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate).toHaveBeenCalledWith({
      operationId: expect.any(String),
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      verdict: 'MIXED',
      summary: 'Useful after correcting the estimate.',
      evidenceRef: 'decision-42',
    })
    expect(
      await screen.findByText(/status, routing, and execution authority were unchanged/i),
    ).toBeTruthy()
    expect(screen.queryByText(/approved|resumed|completed/i)).toBeNull()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('retains the same operation identity after an ambiguous failure', async () => {
    mutate.mockRejectedValueOnce(new Error('unknown outcome')).mockResolvedValueOnce({
      id: 'outcome-1',
      replayed: true,
    })
    render(<AgentOutcomeObservationForm tenantId="tenant-1" venueId="venue-1" agentRunId="run-1" />)
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'Accepted.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record evidence' }))
    expect(await screen.findByText(/same operation identity/i)).toBeTruthy()
    const firstOperationId = mutate.mock.calls[0]?.[0].operationId

    fireEvent.click(screen.getByRole('button', { name: 'Record evidence' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]?.[0].operationId).toBe(firstOperationId)
  })

  it('records a rollback against one exact action', async () => {
    mutateTrustSignal.mockResolvedValue({ id: 'rollback-1', replayed: false })
    render(
      <AgentOutcomeObservationForm
        tenantId="tenant-1"
        venueId="venue-1"
        agentRunId="run-1"
        actions={[{ id: 'action-1', actionName: 'support.apply', status: 'SUCCEEDED' }]}
      />,
    )

    fireEvent.change(screen.getByLabelText('Evidence type'), { target: { value: 'ROLLBACK' } })
    fireEvent.change(screen.getByLabelText('Related action (required)'), {
      target: { value: 'action-1' },
    })
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'The applied change required rollback.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record evidence' }))

    await waitFor(() => expect(mutateTrustSignal).toHaveBeenCalledOnce())
    expect(mutateTrustSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        signalKind: 'ROLLBACK',
        relatedAgentActionId: 'action-1',
        summary: 'The applied change required rollback.',
      }),
    )
    expect(mutate).not.toHaveBeenCalled()
  })

  it('pairs a confidence prediction with reviewed correctness', async () => {
    mutateTrustSignal.mockResolvedValue({ id: 'confidence-1', replayed: false })
    render(<AgentOutcomeObservationForm tenantId="tenant-1" venueId="venue-1" agentRunId="run-1" />)

    fireEvent.change(screen.getByLabelText('Evidence type'), {
      target: { value: 'CONFIDENCE_CALIBRATION' },
    })
    fireEvent.change(screen.getByLabelText('Prediction reference'), {
      target: { value: 'answer-7' },
    })
    fireEvent.change(screen.getByLabelText('Predicted confidence (%)'), {
      target: { value: '82.25' },
    })
    fireEvent.change(screen.getByLabelText('Reviewed result'), {
      target: { value: 'incorrect' },
    })
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'The answer was not supported.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record evidence' }))

    await waitFor(() => expect(mutateTrustSignal).toHaveBeenCalledOnce())
    expect(mutateTrustSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        signalKind: 'CONFIDENCE_CALIBRATION',
        predictionRef: 'answer-7',
        predictedConfidenceBps: 8225,
        actualCorrect: false,
      }),
    )
  })
})
