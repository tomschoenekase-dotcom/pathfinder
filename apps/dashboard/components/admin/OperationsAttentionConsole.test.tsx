/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { OperationsAttentionConsole } from './OperationsAttentionConsole'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const empty = {
  generatedAt: new Date('2026-08-11T14:30:00.000Z'),
  jobs: { items: [], nextCursor: null },
  evaluations: { items: [], nextCursor: null },
  approvals: { items: [], nextCursor: null },
  support: { items: [], nextCursor: null },
  agents: { items: [], nextCursor: null },
}

describe('operations attention console', () => {
  afterEach(cleanup)

  it('renders honest empty states for every bounded queue', () => {
    render(<OperationsAttentionConsole data={empty} />)
    expect(screen.getByText('No failed job records need attention.')).toBeTruthy()
    expect(screen.getByText(/No evaluation runs currently match/)).toBeTruthy()
    expect(screen.getByText('No undecided approval requests are recorded.')).toBeTruthy()
    expect(screen.getByText(/No support requests currently match/)).toBeTruthy()
    expect(screen.getByText('No agent runs are recorded.')).toBeTruthy()
    expect(screen.getByText(/console is read-only/i)).toBeTruthy()
  })

  it('links attention items to exact tenant and venue evidence without raw details', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          evaluations: {
            items: [
              {
                id: 'eval_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                status: 'RUNNING',
                attemptNumber: 2,
                maxAttempts: 3,
                executionLeaseExpiresAt: new Date(),
                lastErrorCode: null,
                createdAt: new Date(),
                expiredLease: true,
              },
            ],
            nextCursor: null,
          },
          support: {
            items: [
              {
                id: 'request_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                category: 'CONTENT_CORRECTION',
                status: 'VALIDATING',
                subject: 'Hours review',
                version: 2,
                updatedAt: new Date(),
                createdAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )
    expect(
      screen.getByRole('link', { name: 'Open evaluation evidence' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/evaluations')
    expect(screen.getByRole('link', { name: 'Open scoped request' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/support-operations?requestId=request_1',
    )
    expect(screen.getByText('Lease expired')).toBeTruthy()
    expect(screen.queryByText('secret provider payload')).toBeNull()
  })
})
