import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.hoisted(() => vi.fn())
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({ publicInterest: { submit: { mutate } } }),
}))

import { RequestDemoForm } from './RequestDemoForm'

describe('RequestDemoForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mutate.mockResolvedValue({ received: true })
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
  })

  it('submits an accessible, normalized request and explains the bounded effect', async () => {
    render(<RequestDemoForm />)
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Avery Guide' } })
    fireEvent.change(screen.getByLabelText('Work email'), {
      target: { value: 'avery@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Organization or venue'), {
      target: { value: 'River Museum' },
    })
    fireEvent.change(screen.getByLabelText(/Website/), { target: { value: 'river.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request a demo' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: '11111111-1111-4111-8111-111111111111',
        organizationName: 'River Museum',
        website: 'https://river.example',
      }),
    )
    expect((await screen.findByRole('status')).textContent).toContain('did not create a price')
  })

  it('keeps the exact request id available for a retry and shows safe errors', async () => {
    mutate.mockRejectedValueOnce(new Error('Too many requests. Please try again later.'))
    render(<RequestDemoForm />)
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Avery Guide' } })
    fireEvent.change(screen.getByLabelText('Work email'), {
      target: { value: 'avery@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Organization or venue'), {
      target: { value: 'River Museum' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Request a demo' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Too many requests')
    fireEvent.click(screen.getByRole('button', { name: 'Request a demo' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[0]?.[0].requestId).toBe(mutate.mock.calls[1]?.[0].requestId)
  })
})
