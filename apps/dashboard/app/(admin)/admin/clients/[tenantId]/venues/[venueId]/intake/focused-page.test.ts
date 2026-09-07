import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ getIntakeHandoff: vi.fn(), listIntakeProposals: vi.fn() }))
vi.mock('../../../../../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({
    mediaIngestion: { getIntakeHandoff: mocks.getIntakeHandoff },
    admin: { listIntakeProposals: mocks.listIntakeProposals },
  }),
}))
vi.mock('../../../../../../../../components/IntakeProposalWorkspace', () => ({
  IntakeProposalWorkspace: () => null,
}))
vi.mock('../../../../../../../../components/admin/IntakeUploadReviewList', () => ({
  IntakeUploadReviewList: () => null,
}))
vi.mock('../../../../../../../../components/admin/OnboardingBootstrapReview', () => ({
  OnboardingBootstrapReview: ({
    tenantId,
    venueId,
    run,
  }: {
    tenantId: string
    venueId: string
    run: { id: string }
  }) =>
    React.createElement(
      'div',
      { 'data-scope': `${tenantId}:${venueId}:${run.id}` },
      'Focused review',
    ),
}))

import AdminIntakePage from './page'

beforeEach(() => vi.resetAllMocks())
describe('exact media proposal navigation', () => {
  it('opens the requested scoped proposal without depending on the first list page', async () => {
    mocks.getIntakeHandoff.mockResolvedValue({
      id: 'run-old',
      displayName: 'Retained media review',
      status: 'AWAITING_REVIEW',
      structuredBootstrap: { kind: 'MEDIA_PROJECT_REVIEW' },
    })
    const result = await AdminIntakePage({
      params: Promise.resolve({ tenantId: 'tenant-a', venueId: 'venue-a' }),
      searchParams: Promise.resolve({ runId: 'run-old' }),
    })
    expect(mocks.getIntakeHandoff).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-old',
    })
    expect(mocks.listIntakeProposals).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(result)).toContain('data-scope="tenant-a:venue-a:run-old"')
  })
  it('shows a recoverable scoped error for an unavailable exact proposal', async () => {
    mocks.getIntakeHandoff.mockRejectedValue(new Error('Wrong venue'))
    const result = await AdminIntakePage({
      params: Promise.resolve({ tenantId: 'tenant-a', venueId: 'venue-b' }),
      searchParams: Promise.resolve({ runId: 'run-old' }),
    })
    const html = renderToStaticMarkup(result)
    expect(html).toContain('Reviewed media proposal unavailable')
    expect(html).toContain('Return to intake workspace')
    expect(html).not.toContain('Focused review')
  })
})
