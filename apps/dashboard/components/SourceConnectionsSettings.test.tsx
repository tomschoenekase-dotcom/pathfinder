/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  requestPreview: vi.fn(),
  approvePreview: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  requestRefresh: vi.fn(),
}))
const stableClient = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../lib/trpc', () => ({ useTRPCClient: () => stableClient.current }))
stableClient.current = {
  sourceConnections: {
    list: { query: mocks.list },
    createDraft: { mutate: mocks.createDraft },
    updateDraft: { mutate: mocks.updateDraft },
    requestPreview: { mutate: mocks.requestPreview },
    approvePreview: { mutate: mocks.approvePreview },
    pause: { mutate: mocks.pause },
    resume: { mutate: mocks.resume },
    requestRefresh: { mutate: mocks.requestRefresh },
  },
}

import { SourceConnectionsSettings } from './SourceConnectionsSettings'

const config = {
  version: 1,
  sourceUrl: 'https://example.org/feed',
  allowedUrls: ['https://example.org/feed'],
  mappings: [
    {
      type: 'html',
      kind: 'event',
      recordSelector: 'article',
      id: { selector: 'h3', attribute: 'text' },
      title: { selector: 'h3', attribute: 'text' },
      text: { selector: 'p', attribute: 'text' },
      dateFormat: 'iso',
    },
  ],
  timezone: 'America/Chicago',
  refreshIntervalSeconds: 3600,
  freshnessSeconds: 10800,
  validation: { minRecords: 1, maxRecords: 50, maxChangedFraction: 0.5, maxRequestsPerDay: 24 },
  publicationPolicy: 'review_required',
}
function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'source_1',
    name: 'Public feed',
    venueId: 'venue_1',
    updatedAt: '2026-10-03T20:00:00.000Z',
    state: 'DISABLED',
    config,
    approved: false,
    preview: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCategory: null,
    consecutiveFailures: 0,
    ...overrides,
  }
}

describe('SourceConnectionsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue([])
    for (const key of [
      'createDraft',
      'updateDraft',
      'requestPreview',
      'approvePreview',
      'pause',
      'resume',
      'requestRefresh',
    ] as const)
      mocks[key].mockResolvedValue({})
  })
  afterEach(cleanup)

  it('creates a paused draft from labeled URL and deterministic selector controls', async () => {
    render(<SourceConnectionsSettings venueId="venue_1" />)
    await screen.findByText('No approved web sources are set up for this venue.')
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Public feed' } })
    fireEvent.change(screen.getByLabelText('Public source URL'), {
      target: { value: 'https://example.org/feed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add draft' }))
    await waitFor(() =>
      expect(mocks.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          venueId: 'venue_1',
          name: 'Public feed',
          config: expect.objectContaining({
            sourceUrl: 'https://example.org/feed',
            allowedUrls: ['https://example.org/feed'],
            mappings: [expect.objectContaining({ type: 'html', recordSelector: 'article' })],
          }),
        }),
      ),
    )
    expect((await screen.findByRole('status')).textContent).toContain('Preview it before approval')
  })

  it('shows extracted facts and issues, then submits the exact preview identity for approval', async () => {
    mocks.list.mockResolvedValue([
      source({
        preview: {
          previewId: 'preview_1',
          previewHash: 'a'.repeat(64),
          configHash: 'b'.repeat(64),
          status: 'VALID',
          observedAt: '2026-10-03T20:05:00.000Z',
          issues: [],
          cost: { fetches: 1, bytes: 800 },
          records: [
            {
              id: 'item_1',
              kind: 'event',
              title: 'Public program',
              text: 'A scheduled program.',
              startDate: '2026-10-05',
              endDate: null,
              showtimes: [],
              links: [],
            },
          ],
        },
      }),
    ])
    render(<SourceConnectionsSettings venueId="venue_1" />)
    const card = await screen.findByTestId('source-connection-source_1')
    expect(within(card).getByText('Public program')).toBeTruthy()
    expect(within(card).getByText(/1 fetch, 800 bytes/u)).toBeTruthy()
    expect(within(card).getByText('Draft')).toBeTruthy()
    expect(within(card).getByText(/Mon, Oct 5, 2026/u)).toBeTruthy()
    expect(within(card).getByText(/Read automatically · no AI usage/u)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Approve preview' }))
    await waitFor(() =>
      expect(mocks.approvePreview).toHaveBeenCalledWith({
        venueId: 'venue_1',
        connectorId: 'source_1',
        expectedUpdatedAt: '2026-10-03T20:00:00.000Z',
        previewId: 'preview_1',
        previewHash: 'a'.repeat(64),
      }),
    )
  })

  it('withholds approval for a review-required preview and refresh until active approval', async () => {
    mocks.list.mockResolvedValue([
      source({
        preview: {
          previewId: 'preview_1',
          previewHash: 'a'.repeat(64),
          configHash: 'b'.repeat(64),
          status: 'REVIEW_REQUIRED',
          observedAt: '2026-10-03T20:05:00.000Z',
          issues: ['RECORD_COUNT_DRIFT'],
          cost: { fetches: 1, bytes: 800 },
          records: [],
        },
      }),
    ])
    render(<SourceConnectionsSettings venueId="venue_1" />)
    const card = await screen.findByTestId('source-connection-source_1')
    expect(
      within(card).getByText('The page now has far more or far fewer items than expected.'),
    ).toBeTruthy()
    expect(within(card).queryByText(/RECORD COUNT DRIFT/u)).toBeNull()
    expect(
      (within(card).getByRole('button', { name: 'Approve preview' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (within(card).getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
  it('allows a valid later preview to be approved for an already approved source', async () => {
    mocks.list.mockResolvedValue([
      source({
        approved: true,
        state: 'ACTIVE',
        config: { ...config, approval: { approvedPreviewHash: 'c'.repeat(64) } },
        preview: {
          previewId: 'preview_next',
          previewHash: 'a'.repeat(64),
          configHash: 'b'.repeat(64),
          status: 'VALID',
          observedAt: '2026-10-03T20:05:00.000Z',
          issues: [],
          records: [],
        },
      }),
    ])
    render(<SourceConnectionsSettings venueId="venue_1" />)
    const card = await screen.findByTestId('source-connection-source_1')
    const approve = within(card).getByRole('button', {
      name: 'Approve preview',
    }) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)
    await waitFor(() =>
      expect(mocks.approvePreview).toHaveBeenCalledWith(
        expect.objectContaining({ previewId: 'preview_next' }),
      ),
    )
  })

  it('resets selectors to JSON pointers when the source type changes', async () => {
    render(<SourceConnectionsSettings venueId="venue_1" />)
    await screen.findByText('No approved web sources are set up for this venue.')
    fireEvent.change(screen.getByLabelText('Source type'), { target: { value: 'json_feed' } })
    expect((screen.getByLabelText('Records') as HTMLInputElement).value).toBe('/items')
    expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe('/id')
  })

  it.each(['html', 'json_feed'])('saves showtime and link controls for %s', async (adapter) => {
    render(<SourceConnectionsSettings venueId="venue_1" />)
    await screen.findByText('No approved web sources are set up for this venue.')
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Public feed' } })
    fireEvent.change(screen.getByLabelText('Public source URL'), {
      target: { value: 'https://example.org/feed' },
    })
    fireEvent.change(screen.getByLabelText('Source type'), { target: { value: adapter } })
    fireEvent.change(screen.getByLabelText('Information kind'), { target: { value: 'showtime' } })
    fireEvent.change(screen.getByLabelText('Showtime start (optional)'), {
      target: { value: adapter === 'html' ? 'time.start' : '/starts' },
    })
    fireEvent.change(screen.getByLabelText('Showtime end (optional)'), {
      target: { value: adapter === 'html' ? 'time.end' : '/ends' },
    })
    fireEvent.change(screen.getByLabelText('Link (optional)'), {
      target: { value: adapter === 'html' ? 'a' : '/links' },
    })
    if (adapter === 'html')
      fireEvent.change(screen.getByLabelText('Showtime value source'), {
        target: { value: 'datetime' },
      })
    fireEvent.click(screen.getByRole('button', { name: 'Add draft' }))
    await waitFor(() =>
      expect(mocks.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            mappings: [
              expect.objectContaining(
                adapter === 'html'
                  ? {
                      kind: 'showtime',
                      showtime: { selector: 'time.start', attribute: 'datetime' },
                      showtimeEnd: { selector: 'time.end', attribute: 'datetime' },
                      link: { selector: 'a', attribute: 'href' },
                    }
                  : {
                      kind: 'showtime',
                      showtimesPointer: '/starts',
                      showtimeEndsPointer: '/ends',
                      linksPointer: '/links',
                    },
              ),
            ],
          }),
        }),
      ),
    )
  })

  it('preserves non-text extraction and additional mapping fields when editing', async () => {
    const richer = {
      ...config,
      mappings: [
        {
          ...config.mappings[0],
          startDate: { selector: 'time', attribute: 'datetime' },
          link: { selector: 'a', attribute: 'href' },
        },
      ],
    }
    mocks.list.mockResolvedValue([source({ config: richer })])
    render(<SourceConnectionsSettings venueId="venue_1" />)
    const card = await screen.findByTestId('source-connection-source_1')
    fireEvent.click(within(card).getByRole('button', { name: 'Edit setup' }))
    expect(screen.getByText(/contains additional fields/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save draft changes' }))
    await waitFor(() =>
      expect(mocks.updateDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            mappings: [
              expect.objectContaining({
                startDate: { selector: 'time', attribute: 'datetime' },
                link: { selector: 'a', attribute: 'href' },
              }),
            ],
          }),
        }),
      ),
    )
  })

  it('shows plain sentences for fetch codes and labels paused sources by approval', async () => {
    mocks.list.mockResolvedValue([
      source({ lastErrorCategory: 'dns_failure', consecutiveFailures: 3 }),
      source({ id: 'source_2', approved: true }),
    ])
    render(<SourceConnectionsSettings venueId="venue_1" />)
    const draft = await screen.findByTestId('source-connection-source_1')
    expect(within(draft).getByText('Draft')).toBeTruthy()
    expect(draft.textContent).toContain('The source address could not be found.')
    expect(draft.textContent).toContain('3 failed checks in a row')
    expect(draft.textContent).toContain('Events from a web page')
    const edit = within(draft).getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement
    expect(edit.title).toBe('Approve a preview first')
    expect(
      within(screen.getByTestId('source-connection-source_2')).getByText('Paused'),
    ).toBeTruthy()
  })

  it('resets the form after adding a draft so it cannot be submitted twice', async () => {
    render(<SourceConnectionsSettings venueId="venue_1" />)
    await screen.findByText('No approved web sources are set up for this venue.')
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Public feed' } })
    fireEvent.change(screen.getByLabelText('Public source URL'), {
      target: { value: 'https://example.org/feed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add draft' }))
    await waitFor(() => expect(mocks.createDraft).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect((screen.getByLabelText('Source name') as HTMLInputElement).value).toBe(''),
    )
    expect((screen.getByLabelText('Public source URL') as HTMLInputElement).value).toBe('')
  })
})
