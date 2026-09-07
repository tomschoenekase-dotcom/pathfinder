/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => ({}) }))

import { MediaIntakeHandoffPanel, type MediaIntakeHandoffAdapter } from './MediaIntakeHandoffPanel'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a', projectId: 'project-a' }
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
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Verified signage.' } })
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
    fireEvent.change(screen.getByRole('textbox'), {
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

  it('invalidates selection when a later source page belongs to a changed saved review', async () => {
    const api = adapter()
    const first = await api.preview(scope)
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
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Verified signage.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Builder proposal' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Retry same handoff' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Prepare saved review' }))
    expect(await screen.findByRole('combobox')).toBeTruthy()
  })
})
