// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { listAgentWorkflowActivations: { query: mocks.query } } }),
}))

import {
  AgentWorkflowActivationLedger,
  type AgentWorkflowActivationLedgerPage,
} from './AgentWorkflowActivationLedger'

const initialPage: AgentWorkflowActivationLedgerPage = {
  heads: [
    {
      registryKey: 'guest-arrival',
      revision: 4,
      selectedRunCount: 9,
      activeVersion: {
        id: 'version-1',
        version: 2,
        contentHash: 'hash-active',
        requiredToolCapabilities: ['venue.read'],
      },
      activationEvent: {
        id: 'event-head',
        kind: 'ACTIVATE',
        eventHash: 'event-head-hash',
        reason: 'Reviewed rollout',
        createdBy: 'admin-1',
        createdAt: '2026-09-07T12:00:00.000Z',
        approvalDecisionId: null,
        promotionAssessmentId: null,
      },
    },
  ],
  events: [
    {
      id: 'event-1',
      registryKey: 'guest-arrival',
      kind: 'ACTIVATE',
      priorVersionId: null,
      resultingVersionId: 'version-1',
      priorRevision: 3,
      resultingRevision: 4,
      eventHash: 'event-1-hash',
      reason: 'Reviewed rollout',
      createdBy: 'admin-1',
      createdAt: '2026-09-07T12:00:00.000Z',
      approvalDecisionId: null,
      promotionAssessmentId: null,
    },
  ],
  nextHeadAfterRegistryKey: 'guest-arrival',
  nextEventBefore: { id: 'event-1', createdAt: '2026-09-07T12:00:00.000Z' },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AgentWorkflowActivationLedger', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('renders the recorded-head boundary and immutable facts without eligibility claims', () => {
    render(
      <AgentWorkflowActivationLedger
        tenantId="tenant-1"
        venueId="venue-1"
        initialPage={initialPage}
      />,
    )
    expect(screen.getByText(/not proof it is currently eligible/)).toBeTruthy()
    expect(screen.getByText('Active version recorded')).toBeTruthy()
    expect(screen.getByText('hash-active')).toBeTruthy()
    expect(screen.getByText('venue.read')).toBeTruthy()
    expect(screen.getByText('event-1-hash')).toBeTruthy()
  })

  it('keeps head and event cursors independent while appending without duplicates', async () => {
    mocks.query
      .mockResolvedValueOnce({
        heads: [{ ...initialPage.heads[0], registryKey: 'parking-help' }],
        events: [{ ...initialPage.events[0], id: 'event-ignored' }],
        nextHeadAfterRegistryKey: null,
        nextEventBefore: initialPage.nextEventBefore,
      })
      .mockResolvedValueOnce({
        heads: [{ ...initialPage.heads[0], registryKey: 'head-ignored' }],
        events: [{ ...initialPage.events[0], id: 'event-2', eventHash: 'event-2-hash' }],
        nextHeadAfterRegistryKey: null,
        nextEventBefore: null,
      })
    render(
      <AgentWorkflowActivationLedger
        tenantId="tenant-1"
        venueId="venue-1"
        initialPage={initialPage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Load more workflow heads' }))
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1))
    expect(mocks.query.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      limit: 20,
      headAfterRegistryKey: 'guest-arrival',
    })
    expect(screen.getByText('parking-help')).toBeTruthy()
    expect(screen.queryByText('event-ignored')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Load older workflow events' }))
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2))
    expect(mocks.query.mock.calls[1]?.[0]).toEqual({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      limit: 20,
      eventBefore: initialPage.nextEventBefore,
    })
    expect(screen.getByText('event-2-hash')).toBeTruthy()
    expect(screen.queryByText('head-ignored')).toBeNull()
  })

  it('shows independent empty states and standard keyboard buttons', () => {
    render(
      <AgentWorkflowActivationLedger
        tenantId="tenant-1"
        venueId="venue-1"
        initialPage={{
          heads: [],
          events: [],
          nextHeadAfterRegistryKey: 'next-head',
          nextEventBefore: { id: 'event-1', createdAt: '2026-09-07T12:00:00.000Z' },
        }}
      />,
    )
    expect(screen.getByText(/No workflow activation heads/)).toBeTruthy()
    expect(screen.getByText(/No workflow lifecycle events/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Load more workflow heads' }).className).toContain(
      'min-h-11',
    )
    expect(screen.getByRole('button', { name: 'Load older workflow events' }).tagName).toBe(
      'BUTTON',
    )
  })

  it('drops a late head response after the venue scope changes', async () => {
    const pending = deferred<AgentWorkflowActivationLedgerPage>()
    mocks.query.mockReturnValueOnce(pending.promise)
    const rendered = render(
      <AgentWorkflowActivationLedger
        tenantId="tenant-1"
        venueId="venue-1"
        initialPage={initialPage}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more workflow heads' }))
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1))
    rendered.rerender(
      <AgentWorkflowActivationLedger
        tenantId="tenant-1"
        venueId="venue-2"
        initialPage={{ ...initialPage, heads: [], nextHeadAfterRegistryKey: null }}
      />,
    )
    await act(async () =>
      pending.resolve({
        ...initialPage,
        heads: [{ ...initialPage.heads[0]!, registryKey: 'late-head' }],
        nextHeadAfterRegistryKey: null,
      }),
    )
    expect(screen.queryByText('late-head')).toBeNull()
  })

  it('has no automated accessibility violations', async () => {
    const { container } = render(
      <AgentWorkflowActivationLedger
        tenantId="tenant-1"
        venueId="venue-1"
        initialPage={initialPage}
      />,
    )
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
