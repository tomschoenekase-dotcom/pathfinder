/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => ({}) }))

import { MediaIntakeHandoffPanel, type MediaIntakeHandoffAdapter } from './MediaIntakeHandoffPanel'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a', projectId: 'project-a' }
const temporalClaim = {
  claimId: 'holiday-hours',
  targetKey: 'place:north-hall:hours',
  targetItemHash: 'a'.repeat(64),
  claimType: 'TEMPORARY_SCHEDULE' as const,
  value: 'Open 10–4 this week',
  valueHash: 'd'.repeat(64),
  authority: 'AUTHORIZED_STAFF' as const,
  consequential: true,
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveUntil: '2026-09-30T00:00:00.000Z',
  source: {
    sourceId: 's1',
    sourceSha256: 'e'.repeat(64),
    sourceVersion: '5c4cae78-84b6-41b7-a152-6593566eeb72',
    capturedAt: null,
    observationIndex: 0,
    observationSha256: 'f'.repeat(64),
  },
}
function adapter() {
  return {
    preview: vi.fn<MediaIntakeHandoffAdapter['preview']>().mockResolvedValue({
      sourceGeneration: '5c4cae78-84b6-41b7-a152-6593566eeb72',
      updatedAt: '2026-09-07T07:30:00.000Z',
      ready: true,
      issues: [],
      items: [{ kind: 'place', itemIndex: 0, itemHash: 'a'.repeat(64), label: 'North Hall' }],
      sources: [{ sourceId: 's1', filename: 'north-hall.mp4' }],
      nextSourceCursor: null,
    }),
    create: vi.fn<MediaIntakeHandoffAdapter['create']>().mockResolvedValue({ runId: 'run-a' }),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
afterEach(cleanup)

describe('reviewed media Builder handoff controls', () => {
  it('does not read or submit while review edits are unsaved', () => {
    const api = adapter()
    render(<MediaIntakeHandoffPanel scope={scope} blocked adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    expect(api.preview).not.toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
  })

  it('requires an explicit source and review note, then opens the exact scoped Builder proposal', async () => {
    const api = adapter()
    render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    const select = await screen.findByRole('combobox', { name: 'North Hall' })
    fireEvent.click(screen.getByRole('button', { name: 'Create Builder proposal' }))
    expect(api.create).not.toHaveBeenCalled()
    fireEvent.change(select, { target: { value: 'source:s1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Review note' }), {
      target: { value: 'Checked the sign and excluded the unfilmed route.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Builder proposal' }))
    await screen.findByRole('link', { name: 'Open in Builder' })
    expect(api.create.mock.calls[0]?.[0]).toMatchObject({
      ...scope,
      bindings: [{ kind: 'place', itemIndex: 0, itemHash: 'a'.repeat(64), sourceIds: ['s1'] }],
    })
    expect(screen.getByRole('link', { name: 'Open in Builder' }).getAttribute('href')).toBe(
      '/admin/clients/tenant-a/venues/venue-a/intake?runId=run-a',
    )
  })

  it('reuses the identical request after an ambiguous failure and locks source edits', async () => {
    const api = adapter()
    api.create.mockRejectedValueOnce(new Error('Network connection lost'))
    render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'source:s1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Review note' }), {
      target: { value: 'Verified signage.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Builder proposal' }))
    await screen.findByRole('alert')
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry same handoff' }))
    await screen.findByRole('link', { name: 'Open in Builder' })
    expect(api.create.mock.calls[1]?.[0]).toEqual(api.create.mock.calls[0]?.[0])
  })

  it('requires an explicit reviewed group choice and carries its full source union', async () => {
    const api = Object.assign(adapter(), {
      getIdentityReview: vi.fn().mockResolvedValue({
        id: '44444444-4444-4444-8444-444444444444',
        revision: 2,
        projection: {
          groups: [{ representativeId: 'entrance-a', candidateIds: ['entrance-a', 'entrance-b'] }],
        },
        candidates: [
          { candidateId: 'entrance-a', label: 'North door', sourceIds: ['s1'] },
          { candidateId: 'entrance-b', label: 'Main entrance', sourceIds: ['s2', 's1'] },
        ],
      }),
    })
    render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    const select = await screen.findByRole('combobox')
    expect(
      screen.getByRole('option', { name: /grouped by reviewer; identity unconfirmed/ }),
    ).toBeTruthy()
    fireEvent.change(select, { target: { value: 'group:entrance-a' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Review note' }), {
      target: { value: 'Reviewed as one entrance.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Builder proposal' }))
    await screen.findByRole('link', { name: 'Open in Builder' })
    expect(api.create.mock.calls[0]![0]).toMatchObject({
      identityReviewId: '44444444-4444-4444-8444-444444444444',
      bindings: [
        {
          entityRepresentativeId: 'entrance-a',
          sourceIds: ['s1', 's2'],
        },
      ],
    })
  })

  it('previews exact temporal claims, shows local holds, and blocks an all-held handoff', async () => {
    const api = Object.assign(adapter(), {
      previewTemporal: vi.fn().mockResolvedValue({
        evaluatedAt: '2026-09-07T12:00:00.000Z',
        authorityBasis: 'REVIEW_ASSERTED',
        authorityVerified: false,
        reviewReceiptHash: 'c'.repeat(64),
        reconciliation: {
          comparisonCount: 1,
          comparisonsTruncated: false,
          selectedClaimIds: ['holiday-hours'],
        },
        items: [
          {
            kind: 'place',
            itemIndex: 0,
            itemHash: 'a'.repeat(64),
            label: 'North Hall',
            handoffStatus: 'HELD',
            holdReasons: ['DATE_BOUND'],
          },
        ],
      }),
    })
    render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'source:s1' } })
    fireEvent.click(screen.getByText('Optional temporal claim review'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Temporal claims JSON' }), {
      target: { value: JSON.stringify([temporalClaim]) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview temporal claims' }))
    expect(await screen.findByText(/0 eligible for the static candidate · 1 retained/)).toBeTruthy()
    expect(screen.getByText('Held · date-bound')).toBeTruthy()
    expect(screen.getByText(/authority asserted for review, not verified/i)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Create Builder proposal' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('freezes the exact normalized temporal claims into the handoff request', async () => {
    const api = Object.assign(adapter(), {
      previewTemporal: vi.fn().mockResolvedValue({
        evaluatedAt: '2026-09-07T12:00:00.000Z',
        authorityBasis: 'REVIEW_ASSERTED',
        authorityVerified: false,
        reviewReceiptHash: 'c'.repeat(64),
        reconciliation: {
          comparisonCount: 1,
          comparisonsTruncated: false,
          selectedClaimIds: ['holiday-hours'],
        },
        items: [
          {
            kind: 'place',
            itemIndex: 0,
            itemHash: 'a'.repeat(64),
            label: 'North Hall',
            handoffStatus: 'ELIGIBLE',
            holdReasons: [],
          },
        ],
      }),
    })
    render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'source:s1' } })
    fireEvent.click(screen.getByText('Optional temporal claim review'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Temporal claims JSON' }), {
      target: { value: JSON.stringify([temporalClaim]) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview temporal claims' }))
    await screen.findByText(/1 eligible for the static candidate/)
    fireEvent.change(screen.getByRole('textbox', { name: 'Review note' }), {
      target: { value: 'Reviewed the dated claim and its exact source.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Builder proposal' }))
    await screen.findByRole('link', { name: 'Open in Builder' })
    expect(api.create.mock.calls[0]![0].temporalClaims).toEqual([temporalClaim])
  })

  it('rejects a temporal claim whose source is not selected for its exact item', async () => {
    const api = Object.assign(adapter(), { previewTemporal: vi.fn() })
    render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'source:s1' } })
    fireEvent.click(screen.getByText('Optional temporal claim review'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Temporal claims JSON' }), {
      target: {
        value: JSON.stringify([
          { ...temporalClaim, source: { ...temporalClaim.source, sourceId: 'different-source' } },
        ]),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview temporal claims' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/must use evidence selected/i)
    expect(api.previewTemporal).not.toHaveBeenCalled()
  })

  it('invalidates selection when a later source page belongs to a changed saved review', async () => {
    const api = adapter()
    const first = await api.preview(scope, new AbortController().signal)
    api.preview
      .mockReset()
      .mockResolvedValueOnce({ ...first, nextSourceCursor: 's1' })
      .mockResolvedValueOnce({ ...first, updatedAt: '2026-09-07T08:00:00.000Z' })
    render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more supporting sources' }))
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    expect(screen.getByRole('alert').textContent).toContain('saved review changed')
    expect(api.create).not.toHaveBeenCalled()
  })

  it('allows a fresh saved review after a definite server conflict', async () => {
    const api = adapter()
    api.create.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
    render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'source:s1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Review note' }), {
      target: { value: 'Verified signage.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Builder proposal' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Retry same handoff' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    expect(await screen.findByRole('combobox')).toBeTruthy()
  })

  it('keeps an old scope completion from populating or unlocking the current scope', async () => {
    const scopeA = deferred<Awaited<ReturnType<MediaIntakeHandoffAdapter['preview']>>>()
    const scopeB = deferred<Awaited<ReturnType<MediaIntakeHandoffAdapter['preview']>>>()
    const signals: AbortSignal[] = []
    const api = adapter()
    api.preview.mockImplementation((input, signal) => {
      signals.push(signal)
      return input.projectId === 'project-a' ? scopeA.promise : scopeB.promise
    })
    const view = render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))

    const nextScope = { ...scope, projectId: 'project-b' }
    view.rerender(<MediaIntakeHandoffPanel scope={nextScope} blocked={false} adapter={api} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Prepare saved review' })).toBeTruthy(),
    )
    expect(signals[0]?.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))

    await act(async () => {
      scopeA.resolve({
        sourceGeneration: '5c4cae78-84b6-41b7-a152-6593566eeb72',
        updatedAt: '2026-09-07T07:30:00.000Z',
        ready: true,
        issues: [],
        items: [{ kind: 'place', itemIndex: 0, itemHash: 'a'.repeat(64), label: 'Old scope' }],
        sources: [{ sourceId: 's1', filename: 'old.mp4' }],
        nextSourceCursor: null,
      })
    })
    expect(screen.queryByText('Old scope')).toBeNull()
    expect(screen.getByRole('button', { name: 'Loading saved review…' })).toBeTruthy()

    await act(async () => {
      scopeB.resolve({
        sourceGeneration: '6c4cae78-84b6-41b7-a152-6593566eeb72',
        updatedAt: '2026-09-07T08:30:00.000Z',
        ready: true,
        issues: [],
        items: [{ kind: 'place', itemIndex: 0, itemHash: 'b'.repeat(64), label: 'Current scope' }],
        sources: [{ sourceId: 's2', filename: 'current.mp4' }],
        nextSourceCursor: null,
      })
    })
    expect(await screen.findByRole('combobox', { name: 'Current scope' })).toBeTruthy()
    expect(screen.queryByText('Old scope')).toBeNull()
  })

  it('ignores an old scope error while the current scope is loading', async () => {
    const scopeA = deferred<Awaited<ReturnType<MediaIntakeHandoffAdapter['preview']>>>()
    const scopeB = deferred<Awaited<ReturnType<MediaIntakeHandoffAdapter['preview']>>>()
    const api = adapter()
    api.preview.mockImplementation((input) =>
      input.projectId === 'project-a' ? scopeA.promise : scopeB.promise,
    )
    const view = render(<MediaIntakeHandoffPanel scope={scope} blocked={false} adapter={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    view.rerender(
      <MediaIntakeHandoffPanel
        scope={{ ...scope, projectId: 'project-b' }}
        blocked={false}
        adapter={api}
      />,
    )
    await waitFor(() => screen.getByRole('button', { name: 'Prepare saved review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    await act(async () => scopeA.reject(new Error('old scope failed')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Loading saved review…' })).toBeTruthy()
    await act(async () => scopeB.reject(new Error('current scope failed')))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not load the saved review. Try again.',
    )
  })
})
