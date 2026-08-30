/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FounderOperatingConversation } from './FounderOperatingConversation'

const mutate = vi.fn()
const refresh = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { askFounderOperatingSystem: { mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
;(globalThis as typeof globalThis & { React: typeof React }).React = React

type Exchanges = React.ComponentProps<typeof FounderOperatingConversation>['exchanges']

const history: Exchanges = [
  {
    id: 'exchange_1',
    operationId: '11111111-1111-4111-8111-111111111111',
    prompt: 'Outreach to the next venue segment.',
    intent: 'DIRECTIVE',
    disposition: 'RECORDED_FOR_TRIAGE',
    responseTitle: 'Direction recorded for triage',
    responseBody: 'Nothing was executed or sent to a customer.',
    evidence: [],
    snapshot: {},
    snapshotHash: 'a'.repeat(64),
    createdAt: new Date('2026-08-25T12:00:00.000Z'),
  },
]

describe('FounderOperatingConversation', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('offers touch-sized founder questions and submits exact durable intent', async () => {
    mutate.mockResolvedValue({
      replayed: false,
      exchange: {
        ...history[0],
        disposition: 'ANSWERED',
        responseTitle: 'No visible founder decisions',
      },
    })
    render(<FounderOperatingConversation exchanges={[]} />)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'What is the highest-value thing I can do in the next five minutes?',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ask Torchiko' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate).toHaveBeenCalledWith({
      operationId: expect.any(String),
      prompt: 'What is the highest-value thing I can do in the next five minutes?',
    })
    expect(
      await screen.findByText(/answered from the current bounded operating snapshot/i),
    ).toBeTruthy()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('labels recorded direction as not executed and passes automated accessibility checks', async () => {
    const { container } = render(<FounderOperatingConversation exchanges={history} />)
    expect(screen.getByText(/recorded for triage · not executed/i)).toBeTruthy()
    expect(screen.getByText(/pricing, billing, customer contact/i)).toBeTruthy()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('keeps the same operation id after an unknown outcome for safe unchanged retry', async () => {
    mutate.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({
      replayed: true,
      exchange: history[0],
    })
    render(<FounderOperatingConversation exchanges={[]} />)
    fireEvent.change(screen.getByLabelText('Ask or direct Torchiko'), {
      target: { value: 'Outreach to the next venue segment.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ask Torchiko' }))
    expect(await screen.findByText(/retry unchanged/i)).toBeTruthy()
    const firstOperationId = mutate.mock.calls[0]![0].operationId

    fireEvent.click(screen.getByRole('button', { name: 'Ask Torchiko' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]![0].operationId).toBe(firstOperationId)
  })
})
