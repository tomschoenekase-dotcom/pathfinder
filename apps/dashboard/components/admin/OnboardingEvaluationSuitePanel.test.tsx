/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: { prepareOnboardingEvaluationSuite: { mutate: mocks.mutate } },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { OnboardingEvaluationSuitePanel } from './OnboardingEvaluationSuitePanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('OnboardingEvaluationSuitePanel', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutate.mockResolvedValue({
      cases: Array.from({ length: 7 }, (_, index) => ({ replayed: index > 1 })),
    })
  })

  it('explains the no-reviewable-package precondition without an action', () => {
    render(
      <OnboardingEvaluationSuitePanel
        tenantId="tenant_1"
        venueId="venue_1"
        reviewablePackages={[]}
      />,
    )
    expect(screen.getByText(/No error-free DRAFT or APPROVED package is available/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Prepare seven cases/ })).toBeNull()
  })

  it('prepares the selected exact package and reports revisions versus replays', async () => {
    render(
      <OnboardingEvaluationSuitePanel
        tenantId="tenant_1"
        venueId="venue_1"
        reviewablePackages={[
          {
            id: 'package_1',
            status: 'DRAFT',
            payloadHash: 'a'.repeat(64),
            baseDigest: 'b'.repeat(64),
            createdAt: new Date('2026-08-18T12:00:00.000Z'),
            approvedAt: null,
            supportHandoffs: [{ supportRequestId: 'support_1', requestVersion: 2 }],
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Prepare seven cases' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      packageId: 'package_1',
      suite: 'CORE',
    })
    expect(await screen.findByText(/2 new revisions, 5 exact replays/)).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('prepares all ten paired launch-language contracts without starting a run', async () => {
    mocks.mutate.mockResolvedValue({
      cases: Array.from({ length: 20 }, (_, index) => ({ replayed: index > 2 })),
    })
    render(
      <OnboardingEvaluationSuitePanel
        tenantId="tenant_1"
        venueId="venue_1"
        reviewablePackages={[
          {
            id: 'package_1',
            status: 'DRAFT',
            payloadHash: 'a'.repeat(64),
            baseDigest: 'b'.repeat(64),
            createdAt: new Date('2026-08-18T12:00:00.000Z'),
            approvedAt: null,
            supportHandoffs: [],
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Prepare 20 language cases' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      packageId: 'package_1',
      suite: 'LAUNCH_LANGUAGES',
    })
    expect(await screen.findByText(/3 new revisions, 17 exact replays/)).toBeTruthy()
    expect(screen.getByText(/does not run AI, spend a budget, publish content/)).toBeTruthy()
  })
})
