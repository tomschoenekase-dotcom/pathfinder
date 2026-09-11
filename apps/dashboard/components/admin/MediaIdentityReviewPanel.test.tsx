/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { mediaEvidenceLocatorId } from '@pathfinder/contracts/media-entity-resolution'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readEvidence: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    mediaIngestion: { readIdentityEvidence: { query: mocks.readEvidence } },
  }),
}))

import {
  MediaIdentityReviewPanel,
  type MediaIdentityReviewDataSource,
} from './MediaIdentityReviewPanel'

const sourceGeneration = '11111111-1111-4111-8111-111111111111'
const updatedAt = '2026-09-07T12:00:00.000Z'
const scope = { tenantId: 'tenant-a', venueId: 'venue-a', projectId: 'project-a', sourceGeneration }
const candidate = (candidateId: string, label: string, sourceId: string) => ({
  candidateId,
  label,
  kind: 'extracted-entity',
  identifiers: [],
  contextKeys: [],
  evidence: [
    {
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      uploadAttemptId: '22222222-2222-4222-8222-222222222222',
      sourceId,
      sourceSha256: 'a'.repeat(64),
      observationIndex: 0,
      observationSha256: 'b'.repeat(64),
    },
  ],
})
const candidates = [
  candidate('mention-a', 'North Hall greenhouse', 'north-hall.mp4'),
  candidate('mention-b', 'Greenhouse entrance', 'entrance.jpg'),
  candidate('mention-c', 'South conservatory', 'south.jpg'),
]
const review = {
  id: '33333333-3333-4333-8333-333333333333',
  revision: 1,
  evidenceSnapshotHash: 'c'.repeat(64),
  createdAt: new Date(updatedAt),
  projection: {
    groups: candidates.map((item) => ({
      representativeId: item.candidateId,
      candidateIds: [item.candidateId],
    })),
    references: candidates.map((item) => ({
      candidateId: item.candidateId,
      representativeId: item.candidateId,
    })),
    activeMergeIds: [],
    relations: [],
    decisionCount: 0,
  },
  candidates: candidates.map((item) => ({
    candidateId: item.candidateId,
    label: item.label,
    kind: item.kind,
    evidenceLocatorIds: item.evidence.map(mediaEvidenceLocatorId),
    sourceIds: item.evidence.map((entry) => entry.sourceId),
  })),
  decisions: [],
}

function adapter(
  overrides: Partial<MediaIdentityReviewDataSource> = {},
): MediaIdentityReviewDataSource {
  return {
    preview: vi
      .fn()
      .mockResolvedValue({ candidates, truncated: false, expectedUpdatedAt: updatedAt }),
    get: vi.fn().mockResolvedValue(review),
    save: vi.fn().mockResolvedValue({
      id: review.id,
      revision: 2,
      evidenceSnapshotHash: review.evidenceSnapshotHash,
      projection: review.projection,
      replayed: false,
    }),
    ...overrides,
  } as MediaIdentityReviewDataSource
}

function renderPanel(dataSource = adapter(), blocked = false) {
  return {
    dataSource,
    ...render(
      <MediaIdentityReviewPanel
        scope={scope}
        expectedUpdatedAt={updatedAt}
        blocked={blocked}
        dataSource={dataSource}
      />,
    ),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('MediaIdentityReviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('React', React)
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '44444444-4444-4444-8444-444444444444') })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('starts only after an explicit action and freezes the bounded candidate preview', async () => {
    const dataSource = adapter({ get: vi.fn().mockResolvedValue(null) })
    renderPanel(dataSource)
    expect(dataSource.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    await screen.findByRole('button', { name: 'Start identity review' })
    expect(dataSource.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start identity review' }))
    await waitFor(() => expect(dataSource.save).toHaveBeenCalledOnce())
    expect(dataSource.save).toHaveBeenCalledWith(
      {
        ...scope,
        requestId: '44444444-4444-4444-8444-444444444444',
        expectedUpdatedAt: updatedAt,
        expectedRevision: 0,
        candidates,
      },
      expect.any(AbortSignal),
    )
  })

  it('submits every member of selected groups with an explicit representative and rationale', async () => {
    const groupedReview = {
      ...review,
      revision: 2,
      projection: {
        ...review.projection,
        groups: [
          { representativeId: 'mention-a', candidateIds: ['mention-a', 'mention-b'] },
          { representativeId: 'mention-c', candidateIds: ['mention-c'] },
        ],
      },
    }
    const dataSource = adapter({ get: vi.fn().mockResolvedValue(groupedReview) })
    renderPanel(dataSource)
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    await screen.findByText('Revision 2')
    const groups = screen.getAllByRole('checkbox')
    fireEvent.click(groups[0]!)
    fireEvent.click(groups[1]!)
    fireEvent.change(screen.getByLabelText('Representative mention'), {
      target: { value: 'mention-c' },
    })
    fireEvent.change(screen.getByLabelText('Why these mentions are the same entity'), {
      target: { value: 'The same doorway and inventory marker appear in both retained sources.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected groups' }))
    await waitFor(() => expect(dataSource.save).toHaveBeenCalledOnce())
    expect(dataSource.save).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 2,
        decision: {
          kind: 'MERGE',
          candidateIds: ['mention-a', 'mention-b', 'mention-c'],
          representativeId: 'mention-c',
          rationale: 'The same doorway and inventory marker appear in both retained sources.',
        },
      }),
      expect.any(AbortSignal),
    )
  })

  it('locks editable controls and retries an unknown acknowledgement with the exact input', async () => {
    const save = vi.fn().mockRejectedValue(new Error('connection interrupted'))
    const dataSource = adapter({ save })
    renderPanel(dataSource)
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    await screen.findByText('Revision 1')
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    fireEvent.change(screen.getByLabelText('Why these mentions are the same entity'), {
      target: { value: 'Same retained doorway.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected groups' }))
    const retry = await screen.findByRole('button', { name: 'Retry exact decision' })
    const first = save.mock.calls[0]![0]
    expect(
      (screen.getByLabelText('Why these mentions are the same entity') as HTMLTextAreaElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(retry)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1]![0]).toEqual(first)
  })

  it('keeps identity mutation disabled while the current media review has unsaved edits', async () => {
    const dataSource = adapter()
    const { container } = renderPanel(dataSource, true)
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    await screen.findByText('Revision 1')
    expect(
      (screen.getAllByRole('checkbox')[0]!.closest('fieldset') as HTMLFieldSetElement).disabled,
    ).toBe(true)
    document.documentElement.lang = 'en'
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map(({ id }) => id)).toEqual([])
  })

  it('refuses to freeze a truncated candidate preview', async () => {
    const dataSource = adapter({
      preview: vi
        .fn()
        .mockResolvedValue({ candidates, truncated: true, expectedUpdatedAt: updatedAt }),
      get: vi.fn().mockResolvedValue(null),
    })
    renderPanel(dataSource)
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /more than 500 identity candidates/i,
    )
    expect(screen.queryByRole('button', { name: 'Start identity review' })).toBeNull()
    expect(dataSource.save).not.toHaveBeenCalled()
  })

  it('requires a rationale and appends a reversion against the active merge request', async () => {
    const mergeRequestId = '55555555-5555-4555-8555-555555555555'
    const mergedReview = {
      ...review,
      revision: 2,
      projection: {
        ...review.projection,
        groups: [
          { representativeId: 'mention-a', candidateIds: ['mention-a', 'mention-b'] },
          { representativeId: 'mention-c', candidateIds: ['mention-c'] },
        ],
        activeMergeIds: [mergeRequestId],
        decisionCount: 1,
      },
      decisions: [
        {
          kind: 'MERGE' as const,
          requestId: mergeRequestId,
          candidateIds: ['mention-a', 'mention-b'],
          representativeId: 'mention-a',
          reviewerId: 'reviewer-a',
          rationale: 'Same retained doorway.',
        },
      ],
    }
    const dataSource = adapter({ get: vi.fn().mockResolvedValue(mergedReview) })
    renderPanel(dataSource)
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    await screen.findByText('Revision 2')
    fireEvent.click(screen.getByRole('button', { name: 'Revert this merge' }))
    const confirm = screen.getByRole('button', { name: 'Confirm merge reversion' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Why this merge should be reverted'), {
      target: { value: 'The retained signs identify two different entrances.' },
    })
    fireEvent.click(confirm)
    await waitFor(() => expect(dataSource.save).toHaveBeenCalledOnce())
    expect(dataSource.save).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 2,
        decision: {
          kind: 'REVERT_MERGE',
          mergeRequestId,
          rationale: 'The retained signs identify two different entrances.',
        },
      }),
      expect.any(AbortSignal),
    )
  })

  it('fences late completion from the prior source scope without unlocking the replacement load', async () => {
    const oldPreview = deferred<Awaited<ReturnType<MediaIdentityReviewDataSource['preview']>>>()
    const oldReview = deferred<Awaited<ReturnType<MediaIdentityReviewDataSource['get']>>>()
    const newPreview = deferred<Awaited<ReturnType<MediaIdentityReviewDataSource['preview']>>>()
    const newReview = deferred<Awaited<ReturnType<MediaIdentityReviewDataSource['get']>>>()
    const dataSource = adapter({
      preview: vi.fn((input) =>
        input.projectId === 'project-a' ? oldPreview.promise : newPreview.promise,
      ),
      get: vi.fn((input) =>
        input.projectId === 'project-a' ? oldReview.promise : newReview.promise,
      ),
    })
    const view = renderPanel(dataSource)
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    const replacementScope = { ...scope, projectId: 'project-b' }
    view.rerender(
      <MediaIdentityReviewPanel
        scope={replacementScope}
        expectedUpdatedAt={updatedAt}
        blocked={false}
        dataSource={dataSource}
      />,
    )
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Preview candidates' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    oldPreview.resolve({ candidates, truncated: false, expectedUpdatedAt: updatedAt })
    oldReview.resolve(review)
    await Promise.resolve()
    expect(screen.queryByText('North Hall greenhouse')).toBeNull()
    expect((screen.getByRole('button', { name: 'Loading…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    const replacementReview = {
      ...review,
      revision: 7,
      candidates: review.candidates.map((item) =>
        item.candidateId === 'mention-a' ? { ...item, label: 'Replacement scope candidate' } : item,
      ),
    }
    newPreview.resolve({ candidates, truncated: false, expectedUpdatedAt: updatedAt })
    newReview.resolve(replacementReview)
    expect(await screen.findByText('Revision 7')).toBeTruthy()
    expect(screen.getAllByText('Replacement scope candidate').length).toBeGreaterThan(0)
  })

  it('does not surface a late prior-scope read error in the replacement scope', async () => {
    const oldPreview = deferred<Awaited<ReturnType<MediaIdentityReviewDataSource['preview']>>>()
    const dataSource = adapter({ preview: vi.fn(() => oldPreview.promise) })
    const view = renderPanel(dataSource)
    fireEvent.click(screen.getByRole('button', { name: 'Preview candidates' }))
    view.rerender(
      <MediaIdentityReviewPanel
        scope={{ ...scope, projectId: 'project-b' }}
        expectedUpdatedAt={updatedAt}
        blocked={false}
        dataSource={dataSource}
      />,
    )
    oldPreview.reject(new Error('late old-scope failure'))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
