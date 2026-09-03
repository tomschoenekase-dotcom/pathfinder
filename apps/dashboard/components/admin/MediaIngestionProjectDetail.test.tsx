/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  listAssets: vi.fn(),
  listFindings: vi.fn(),
  saveReview: vi.fn(),
  status: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    mediaIngestion: {
      get: { query: mocks.get },
      listAssets: { query: mocks.listAssets },
      listFindings: { query: mocks.listFindings },
      saveReview: { mutate: mocks.saveReview },
      status: { query: mocks.status },
    },
  }),
}))

import { MediaIngestionProjectDetail } from './MediaIngestionProjectDetail'
import { MediaIngestionReview } from './MediaIngestionReview'

const updatedAt = new Date('2026-08-08T18:00:00.000Z')
const generation = '11111111-1111-4111-8111-111111111111'

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project_1',
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    name: 'Museum visit',
    context: '',
    mode: 'BALANCED' as const,
    status: 'READY_FOR_REVIEW' as const,
    stage: 'review',
    progress: 100,
    sourceFileName: 'visit.zip',
    sourceBytes: 10,
    sourceLastModified: 123,
    sourceFingerprintAlgorithm: 'pathfinder-sha256-part-manifest-v1',
    uploadAttemptId: null,
    settings: {},
    coverage: {},
    questions: [{ id: 'Q-1', question: 'Is it accessible?' }],
    findings: [
      {
        sourceId: 'S-1',
        filename: 'hall.jpg',
        mediaType: 'IMAGE' as const,
        summary: 'Original hall summary',
        uncertainties: ['Sign is partly hidden'],
      },
    ],
    findingsNextCursor: null,
    draftJson: {
      schemaVersion: 1,
      places: [{ name: 'Hall', type: 'exhibit', tags: [], importanceScore: 50 }],
      knowledgeEntries: [],
    },
    estimatedCostCents: null,
    actualCostCents: 0,
    error: null,
    createdAt: updatedAt,
    updatedAt,
    completedAt: updatedAt,
    reviewGeneration: generation,
    assets: [
      {
        id: 'asset_1',
        sourceId: 'S-1',
        filename: 'hall.jpg',
        mediaType: 'IMAGE' as const,
        bytes: 2048,
        status: 'COMPLETE' as const,
        analysis: {},
        error: null,
        updatedAt,
      },
    ],
    assetsTruncated: false,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('media ingestion project detail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('polls sequentially and replaces the running screen with authoritative review detail', async () => {
    vi.useFakeTimers()
    const ready = project()
    mocks.status.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      reviewGeneration: generation,
      status: 'READY_FOR_REVIEW',
      stage: 'review',
      progress: 100,
      coverage: {},
      error: null,
      updatedAt,
      completedAt: updatedAt,
      hasDraft: true,
    })
    mocks.get.mockResolvedValueOnce(ready)

    render(
      <MediaIngestionProjectDetail
        initialProject={project({
          status: 'ANALYZING',
          stage: 'analysis',
          progress: 40,
          draftJson: null,
          findings: [],
          questions: [],
          assets: [],
          completedAt: null,
        })}
      />,
    )
    expect(screen.getByText(/update automatically/)).toBeTruthy()

    await act(async () => vi.advanceTimersByTimeAsync(3_000))

    expect(mocks.status).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        projectId: 'project_1',
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.get).toHaveBeenCalledOnce()
    expect(screen.getByText('Source evidence')).toBeTruthy()
  })

  it('keeps the last confirmed state and reports degraded polling', async () => {
    vi.useFakeTimers()
    mocks.status.mockRejectedValueOnce(new Error('network down'))
    render(
      <MediaIngestionProjectDetail
        initialProject={project({ status: 'ANALYZING', draftJson: null, completedAt: null })}
      />,
    )

    await act(async () => vi.advanceTimersByTimeAsync(3_000))

    expect(screen.getByText(/last confirmed state is shown/i)).toBeTruthy()
    expect(screen.getByText(/Analysis is running/)).toBeTruthy()
  })

  it('aborts a stalled status request and retries from the last confirmed state', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    mocks.status.mockImplementation((_input, options: { signal: AbortSignal }) => {
      requestSignal = options.signal
      return new Promise<never>(() => undefined)
    })
    render(
      <MediaIngestionProjectDetail
        initialProject={project({ status: 'ANALYZING', draftJson: null, completedAt: null })}
      />,
    )

    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(mocks.status).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(requestSignal?.aborted).toBe(true)
    expect(screen.getByText(/last confirmed state is shown/i)).toBeTruthy()
  })

  it('aborts an in-flight status request when the project page unmounts', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    mocks.status.mockImplementation((_input, options: { signal: AbortSignal }) => {
      requestSignal = options.signal
      return new Promise<never>(() => undefined)
    })
    const view = render(
      <MediaIngestionProjectDetail
        initialProject={project({ status: 'ANALYZING', draftJson: null, completedAt: null })}
      />,
    )
    await act(async () => vi.advanceTimersByTimeAsync(3_000))

    view.unmount()

    expect(requestSignal?.aborted).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(mocks.status).toHaveBeenCalledOnce()
  })
})

describe('media ingestion review', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.saveReview.mockResolvedValue({
      ok: true,
      updatedAt: new Date('2026-08-08T18:01:00.000Z'),
      status: 'READY_FOR_REVIEW',
      questions: [{ id: 'Q-1', question: 'Is it accessible?', answer: 'Yes, via the east ramp.' }],
      findingReviews: [
        {
          sourceId: 'S-1',
          review: {
            summary: 'Verified hall summary',
            uncertainties: ['Sign is partly hidden'],
            note: 'Checked against the source.',
            reviewedBy: 'user_1',
            reviewedAt: '2026-08-08T18:01:00.000Z',
          },
        },
      ],
    })
    mocks.listAssets.mockResolvedValue({ items: [], nextCursor: null })
    mocks.listFindings.mockResolvedValue({ items: [], nextCursor: null })
  })

  afterEach(cleanup)

  it('saves answer and evidence corrections with the exact venue and generation fence', async () => {
    render(<MediaIngestionReview initialProject={project()} />)

    fireEvent.change(screen.getByLabelText('Is it accessible?'), {
      target: { value: 'Yes, via the east ramp.' },
    })
    fireEvent.change(screen.getByLabelText('Corrected summary'), {
      target: { value: 'Verified hall summary' },
    })
    fireEvent.change(screen.getByLabelText('Reviewer note'), {
      target: { value: 'Checked against the source.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }))

    await waitFor(() => expect(mocks.saveReview).toHaveBeenCalledOnce())
    expect(mocks.saveReview).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        projectId: 'project_1',
        reviewGeneration: generation,
        expectedUpdatedAt: updatedAt,
        questionAnswers: [{ id: 'Q-1', answer: 'Yes, via the east ramp.' }],
        findingCorrections: [
          {
            sourceId: 'S-1',
            summary: 'Verified hall summary',
            uncertainties: ['Sign is partly hidden'],
            note: 'Checked against the source.',
          },
        ],
        draftJson: expect.objectContaining({ schemaVersion: 1 }),
      }),
    )
    expect(await screen.findByText('Review saved and ready.')).toBeTruthy()
    expect(screen.getByText(/do not silently rewrite the venue-package draft/i)).toBeTruthy()
    expect(screen.getByText(/2.0 KiB/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save review' }))
    await waitFor(() => expect(mocks.saveReview).toHaveBeenCalledTimes(2))
    expect(mocks.saveReview.mock.calls[1]?.[0]).toMatchObject({ findingCorrections: [] })
  })

  it('shows the retained analysis route for each video finding', () => {
    render(
      <MediaIngestionReview
        initialProject={project({
          findings: [
            {
              sourceId: 'S-1',
              filename: 'walkthrough.mp4',
              mediaType: 'VIDEO',
              videoAnalysisMethod: 'GOOGLE_COMPLETE_VIDEO',
              summary: 'Complete walkthrough summary',
              uncertainties: [],
            },
          ],
          assets: [
            {
              id: 'asset_1',
              sourceId: 'S-1',
              filename: 'walkthrough.mp4',
              mediaType: 'VIDEO',
              bytes: 2048,
              status: 'COMPLETE',
              error: null,
              updatedAt,
            },
          ],
        })}
      />,
    )

    expect(screen.getByText('Google complete-video analysis')).toBeTruthy()
  })

  it('surfaces optimistic-concurrency conflicts without claiming a save', async () => {
    mocks.saveReview.mockRejectedValueOnce(
      new Error('This review changed in another session. Reload before saving again.'),
    )
    render(<MediaIngestionReview initialProject={project()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }))

    expect(await screen.findByText(/changed in another session/)).toBeTruthy()
    expect(screen.queryByText('Review saved and ready.')).toBeNull()
  })

  it('synchronously fences duplicate review saves', async () => {
    const pending = deferred<Awaited<ReturnType<typeof mocks.saveReview>>>()
    mocks.saveReview.mockReturnValueOnce(pending.promise)
    render(<MediaIngestionReview initialProject={project()} />)
    const save = screen.getByRole('button', { name: 'Save review' })

    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.saveReview).toHaveBeenCalledOnce()
    pending.resolve({
      ok: true,
      updatedAt: new Date('2026-08-08T18:01:00.000Z'),
      status: 'READY_FOR_REVIEW',
      questions: [],
      findingReviews: [],
    })
    await act(async () => pending.promise)
  })

  it('replaces the editable findings page and keeps the form bounded', async () => {
    mocks.listFindings.mockResolvedValueOnce({
      items: [
        {
          sourceId: 'S-51',
          filename: 'next.jpg',
          mediaType: 'IMAGE',
          summary: 'Next page summary',
          uncertainties: [],
        },
      ],
      nextCursor: null,
    })
    render(<MediaIngestionReview initialProject={project({ findingsNextCursor: 'S-50' })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Next findings' }))

    expect(await screen.findByText('next.jpg')).toBeTruthy()
    expect(screen.queryByText('hall.jpg')).toBeNull()
    expect(mocks.listFindings).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        projectId: 'project_1',
        reviewGeneration: generation,
        cursor: 'S-50',
      },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('aborts an in-flight findings page read on unmount', async () => {
    mocks.listFindings.mockImplementation(() => new Promise(() => undefined))
    const view = render(
      <MediaIngestionReview initialProject={project({ findingsNextCursor: 'S-50' })} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next findings' }))
    await waitFor(() => expect(mocks.listFindings).toHaveBeenCalledOnce())
    const signal = mocks.listFindings.mock.calls[0]?.[1]?.signal as AbortSignal

    view.unmount()

    expect(signal.aborted).toBe(true)
  })

  it('blocks download and save for legacy synthesis JSON that is not a venue package', () => {
    render(
      <MediaIngestionReview
        initialProject={project({
          draftJson: {
            schemaVersion: 1,
            places: [{ title: 'Legacy hall', type: 'exhibit', description: 'Old shape' }],
            knowledgeEntries: [],
            questions: [],
            coverage: {},
          },
        })}
      />,
    )

    expect(screen.getByText(/does not match the Venue Package v1 contract/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Download JSON' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Save review' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
