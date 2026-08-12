/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreshnessReviewControl } from './FreshnessReviewControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { confirmFreshnessCurrent: { mutate: mocks.mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

describe('FreshnessReviewControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutate.mockResolvedValue({})
  })
  afterEach(cleanup)

  it('requires explicit human confirmation and explains the non-publishing boundary', () => {
    render(
      <FreshnessReviewControl
        tenantId="tenant_1"
        venueId="venue_1"
        entityType="PLACE"
        entityId="place_1"
        label="North Hall"
        expectedUpdatedAt={new Date('2026-08-10T10:00:00.000Z')}
      />,
    )
    fireEvent.click(screen.getByText('Review current content'))
    expect(screen.getByText(/does not edit factual content, publish/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Confirm current content' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (
        screen.getByRole('checkbox', {
          name: /explicitly confirm it is current/i,
        }) as HTMLInputElement
      ).required,
    ).toBe(true)
  })

  it('submits exact scope, CAS, explicit conclusion, and only entered provenance repairs', async () => {
    render(
      <FreshnessReviewControl
        tenantId="tenant_1"
        venueId="venue_1"
        entityType="KNOWLEDGE_ENTRY"
        entityId="knowledge_1"
        label="Arrival guide"
        expectedUpdatedAt={new Date('2026-08-10T10:00:00.000Z')}
      />,
    )
    fireEvent.click(screen.getByText('Review current content'))
    fireEvent.change(screen.getByLabelText('Source type'), { target: { value: 'DOCUMENT' } })
    fireEvent.change(screen.getByLabelText('Source name'), {
      target: { value: 'Operations guide' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /explicitly confirm it is current/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm current content' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: 'knowledge_1',
      expectedUpdatedAt: new Date('2026-08-10T10:00:00.000Z'),
      conclusion: 'CONFIRMED_CURRENT',
      explicitlyConfirmedCurrent: true,
      provenanceRepair: { sourceType: 'DOCUMENT', sourceName: 'Operations guide' },
    })
    expect((await screen.findByRole('status')).textContent).toMatch(/without publishing/)
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('leaves a stale record unchanged and asks the reviewer to refresh', async () => {
    mocks.mutate.mockRejectedValue({ data: { code: 'CONFLICT' } })
    render(
      <FreshnessReviewControl
        tenantId="tenant_1"
        venueId="venue_1"
        entityType="PLACE"
        entityId="place_1"
        label="North Hall"
        expectedUpdatedAt={new Date('2026-08-10T10:00:00.000Z')}
      />,
    )
    fireEvent.click(screen.getByText('Review current content'))
    fireEvent.click(screen.getByRole('checkbox', { name: /explicitly confirm it is current/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm current content' }))
    expect((await screen.findByRole('status')).textContent).toMatch(/changed.*Refresh/i)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
