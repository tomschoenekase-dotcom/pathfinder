/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import DashboardOnboardingPage from './page'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  replace: vi.fn(),
  setActive: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('@clerk/nextjs', () => ({
  OrganizationList: () => <div>Organization list</div>,
  SignOutButton: ({ children }: { children: React.ReactNode }) => children,
  useClerk: () => ({ createOrganization: vi.fn() }),
  useOrganizationList: () => ({
    isLoaded: true,
    setActive: mocks.setActive,
    userMemberships: { data: [], isLoading: false },
    userInvitations: {
      isLoading: false,
      data: [
        {
          id: 'invite_1',
          emailAddress: 'client+clerk_test@example.com',
          publicOrganizationData: { id: 'org_1', name: 'Synthetic Venue' },
          accept: mocks.accept,
        },
      ],
    },
  }),
}))

describe('dashboard organization onboarding', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lets a signed-in fake-email user accept a pending venue invitation in the app', async () => {
    mocks.accept.mockResolvedValue({})
    mocks.setActive.mockResolvedValue({})
    render(<DashboardOnboardingPage />)

    expect(screen.getByText('Synthetic Venue')).toBeTruthy()
    expect(screen.getByText('client+clerk_test@example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Accept invitation/ }))

    await vi.waitFor(() => {
      expect(mocks.accept).toHaveBeenCalledOnce()
      expect(mocks.setActive).toHaveBeenCalledWith({ organization: 'org_1' })
      expect(mocks.replace).toHaveBeenCalledWith('/')
    })
  })
})
