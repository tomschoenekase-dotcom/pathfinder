/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      getIntakeVenuePackageCandidate: { query },
      createAndLinkIntakeCandidateDraft: { mutate: vi.fn() },
    },
  }),
}))

import { OnboardingBootstrapReview } from './OnboardingBootstrapReview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('OnboardingBootstrapReview', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('deliberately loads a read-only deterministic candidate and keeps raw input collapsed', async () => {
    query.mockResolvedValue(candidate())
    render(
      <OnboardingBootstrapReview
        tenantId="tenant-1"
        venueId="venue-1"
        run={{
          id: 'run-1',
          displayName: 'Initial setup',
          status: 'AWAITING_REVIEW',
          structuredBootstrap: { private: 'source proposal' },
        }}
      />,
    )
    expect(screen.getByText('View original private proposal').closest('details')?.open).toBe(false)
    expect(screen.queryByLabelText('VenuePackage payload JSON')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review package candidate' }))
    expect(await screen.findByText(/Candidate from structured onboarding proposal/)).toBeTruthy()
    expect(query).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      runId: 'run-1',
    })
    expect(
      (screen.getByLabelText('VenuePackage payload JSON') as HTMLTextAreaElement).readOnly,
    ).toBe(true)
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
  })

  it('shows server issues and does not mount a draft action for a blocked candidate', async () => {
    query.mockResolvedValue({
      ...candidate(),
      ready: false,
      candidateHash: null,
      payload: null,
      issues: [
        {
          code: 'PACKAGE_FIELD_INVALID',
          path: 'knowledgeEntries.create.0.value.content',
          message: 'Candidate content is too long.',
        },
      ],
      summary: { candidateCount: 1, issueCount: 1 },
    })
    render(
      <OnboardingBootstrapReview
        tenantId="tenant-1"
        venueId="venue-1"
        run={{
          id: 'run-1',
          displayName: 'Initial setup',
          status: 'AWAITING_REVIEW',
          structuredBootstrap: {},
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review package candidate' }))
    expect(await screen.findByText('Candidate content is too long.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create and link DRAFT only' })).toBeNull()
  })
})

function candidate() {
  return {
    runId: 'run-1',
    sourceKind: 'STRUCTURED_BOOTSTRAP' as const,
    status: 'AWAITING_REVIEW',
    ready: true,
    candidateHash: 'a'.repeat(64),
    payload: {
      schemaVersion: 3 as const,
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [], update: [], delete: [] },
    },
    issues: [],
    summary: { candidateCount: 1, issueCount: 0 },
    autoApprove: false as const,
    autoApply: false as const,
    published: false as const,
  }
}
