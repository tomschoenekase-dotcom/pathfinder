/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  test: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}))

// The real provider client is stable for the life of the route; the mock must be too.
const stableClient = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../lib/trpc', () => ({ useTRPCClient: () => stableClient.current }))
stableClient.current = {
  liveData: {
    policy: { query: mocks.policy },
    list: { query: mocks.list },
    create: { mutate: mocks.create },
    test: { mutate: mocks.test },
    enable: { mutate: mocks.enable },
    disable: { mutate: mocks.disable },
  },
}

import { LiveDataSettings } from './LiveDataSettings'

const policy = {
  generalKnowledge: { mode: 'APPROVED_VENUE_ONLY', allowedDomainCount: 0 },
  openWeb: { enabled: false, enablement: 'PLATFORM_ADMIN_ONLY', implemented: false },
  liveConnectors: { activeCount: 1, totalCount: 2 },
}

function connector(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn_1',
    name: 'Home game',
    kind: 'sports_score',
    provider: 'fixture-sports',
    resourceId: 'game.home',
    resourceLabel: 'Hawks home game',
    endpointHost: 'feeds.example-sports.com',
    mapping: { fields: { homeScore: { pointer: '/h', type: 'integer' } } },
    pollIntervalSeconds: 60,
    freshnessBudgetSeconds: 180,
    enabled: true,
    lastSuccessAt: new Date('2026-10-02T18:00:00Z'),
    lastErrorCategory: null,
    consecutiveFailures: 0,
    lastTest: {
      at: new Date('2026-10-02T17:00:00Z'),
      outcome: 'OK',
      errorCategory: null,
      preview: {},
    },
    liveState: 'fresh',
    observedAt: '2026-10-02T18:00:00.000Z',
    ...overrides,
  }
}

describe('LiveDataSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.policy.mockResolvedValue(policy)
    mocks.list.mockResolvedValue([connector()])
    mocks.test.mockResolvedValue({ queued: true })
    mocks.enable.mockResolvedValue({})
    mocks.disable.mockResolvedValue({})
    mocks.create.mockResolvedValue({ id: 'conn_2' })
  })
  afterEach(cleanup)

  it('shows the three knowledge concepts and the customer wording', async () => {
    render(<LiveDataSettings venueId="venue_1" />)
    expect(
      screen.getByText(
        'The guide does not freely browse the public web; it uses approved venue information and configured live sources.',
      ),
    ).toBeTruthy()
    await screen.findByText('Approved venue content only.')
    expect(
      screen.getByText(/Off\. Turning it on would need a Torchiko platform admin/u),
    ).toBeTruthy()
    expect(screen.getByText(/1 on, 2 set up\./u)).toBeTruthy()
    expect(mocks.policy).toHaveBeenCalledWith(
      { venueId: 'venue_1' },
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.list).toHaveBeenCalledWith(
      { venueId: 'venue_1' },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('shows kind, mapping, last success, state and test result for each connector', async () => {
    render(<LiveDataSettings venueId="venue_1" />)
    const card = await screen.findByTestId('live-connector-conn_1')
    expect(
      within(card).getByText(/Game score from fixture-sports via feeds\.example-sports\.com/u),
    ).toBeTruthy()
    expect(within(card).getByText(/homeScore ← \/h/u)).toBeTruthy()
    expect(within(card).getByText('Fresh')).toBeTruthy()
    expect(within(card).getByText(/Last test .*worked/u)).toBeTruthy()
  })

  it('surfaces stale and error state in plain words', async () => {
    mocks.list.mockResolvedValue([
      connector({
        liveState: 'unavailable',
        lastErrorCategory: 'timeout',
        consecutiveFailures: 3,
        lastTest: {
          at: new Date(),
          outcome: 'FAILED',
          errorCategory: 'blocked_address',
          preview: null,
        },
      }),
    ])
    render(<LiveDataSettings venueId="venue_1" />)
    const card = await screen.findByTestId('live-connector-conn_1')
    expect(within(card).getByText('Unavailable: guide will not quote it')).toBeTruthy()
    expect(within(card).getByText(/Provider timed out \(3 in a row\)/u)).toBeTruthy()
    expect(within(card).getByText(/failed \(Address is not allowed\)/u)).toBeTruthy()
  })

  it('tests, turns off, and reloads after each change', async () => {
    render(<LiveDataSettings venueId="venue_1" />)
    const card = await screen.findByTestId('live-connector-conn_1')
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(mocks.test).toHaveBeenCalledWith({ connectorId: 'conn_1' }))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))

    fireEvent.click(within(card).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(mocks.disable).toHaveBeenCalledWith({ connectorId: 'conn_1' }))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3))
  })

  it('offers Turn on for a disabled connector', async () => {
    mocks.list.mockResolvedValue([connector({ enabled: false, liveState: 'unknown' })])
    render(<LiveDataSettings venueId="venue_1" />)
    const card = await screen.findByTestId('live-connector-conn_1')
    expect(within(card).getByText('Off')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith({ connectorId: 'conn_1' }))
  })

  it('creates a ride source from structured fields without tenant authority or secrets', async () => {
    render(<LiveDataSettings venueId="venue_1" />)
    await screen.findByTestId('live-connector-conn_1')
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'ride_status' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Coaster' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'fixture-rides' } })
    fireEvent.change(screen.getByLabelText('What visitors call it'), {
      target: { value: 'Skyline Coaster' },
    })
    fireEvent.change(screen.getByLabelText(/Resource ID/u), { target: { value: 'ride.coaster' } })
    fireEvent.change(screen.getByLabelText('Feed address (https)'), {
      target: { value: 'https://feeds.example-rides.com/coaster' },
    })
    fireEvent.change(screen.getByLabelText(/^status \(required\)/u), {
      target: { value: '/ride/open' },
    })
    fireEvent.change(screen.getByLabelText(/^waitMinutes/u), { target: { value: '/ride/wait' } })
    fireEvent.change(screen.getByLabelText(/Status words/u), {
      target: { value: 'true = open\nfalse = down' },
    })
    fireEvent.change(screen.getByLabelText(/Provider timestamp/u), { target: { value: '/asOf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add live source' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    const input = mocks.create.mock.calls[0]![0]
    expect(input).toMatchObject({
      venueId: 'venue_1',
      kind: 'ride_status',
      resourceId: 'ride.coaster',
      endpointUrl: 'https://feeds.example-rides.com/coaster',
      mapping: {
        observedAt: { pointer: '/asOf', format: 'iso8601' },
        fields: {
          status: {
            pointer: '/ride/open',
            type: 'status',
            statusMap: { true: 'open', false: 'down' },
          },
          waitMinutes: { pointer: '/ride/wait', type: 'integer', unit: 'minutes' },
        },
      },
    })
    expect(Object.keys(input)).not.toContain('tenantId')
    expect(await screen.findByText(/It is off until you test it and turn it on/u)).toBeTruthy()
  })

  it('shows a server rejection (for example a blocked address) without clearing the form', async () => {
    mocks.create.mockRejectedValue(new Error('Private addresses are not allowed.'))
    render(<LiveDataSettings venueId="venue_1" />)
    await screen.findByTestId('live-connector-conn_1')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'p' } })
    fireEvent.change(screen.getByLabelText('What visitors call it'), { target: { value: 'Bad' } })
    fireEvent.change(screen.getByLabelText(/Resource ID/u), { target: { value: 'bad' } })
    fireEvent.change(screen.getByLabelText('Feed address (https)'), {
      target: { value: 'https://10.0.0.1/x' },
    })
    fireEvent.change(screen.getByLabelText(/^homeScore/u), { target: { value: '/h' } })
    fireEvent.change(screen.getByLabelText(/^awayScore/u), { target: { value: '/a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add live source' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Private addresses are not allowed.',
    )
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Bad')
  })
})
