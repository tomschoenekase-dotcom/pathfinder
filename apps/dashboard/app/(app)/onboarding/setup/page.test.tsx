/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))

vi.mock('../../../../lib/trpc', () => ({
  useTRPCClient: () => ({ venue: { create: { mutate: mocks.create } } }),
}))

import OnboardingSetupPage from './page'

describe('minimal onboarding setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.create.mockResolvedValue({ id: 'venue / 1' })
  })

  afterEach(cleanup)

  it('asks only for the venue name before materials', () => {
    render(<OnboardingSetupPage />)
    expect(screen.getByRole('heading', { name: 'Start with your venue' })).toBeTruthy()
    expect(screen.getByLabelText('Venue name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create venue and add materials' })).toBeTruthy()
    expect(screen.queryByText(/Step 1 of/)).toBeNull()
    expect(screen.queryByLabelText(/latitude|longitude|category|guide item/iu)).toBeNull()
  })

  it('creates a non-location venue and goes directly to its materials page', async () => {
    render(<OnboardingSetupPage />)
    fireEvent.change(screen.getByLabelText('Venue name'), {
      target: { value: '  Harbor Museum  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create venue and add materials' }))

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'Harbor Museum',
        guideMode: 'non_location',
      }),
    )
    expect(mocks.push).toHaveBeenCalledWith('/venues/venue%20%2F%201/onboarding')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('fences double submission and exposes only a safe error', async () => {
    mocks.create.mockRejectedValue(new Error('secret provider detail'))
    render(<OnboardingSetupPage />)
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Museum' } })
    const button = screen.getByRole('button', { name: 'Create venue and add materials' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Torchiko could not create the venue. Please try again.',
    )
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('secret provider detail')
  })

  it('gives an actionable safe message when the selected client context expires', async () => {
    mocks.create.mockRejectedValue(new Error('FORBIDDEN: Insufficient role'))
    render(<OnboardingSetupPage />)
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Museum' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create venue and add materials' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your client workspace selection expired. Return to Admin, open the client again, and retry.',
    )
    expect(document.body.textContent).not.toContain('Insufficient role')
  })
})
