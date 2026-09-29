/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => {
  const preview = vi.fn()
  const apply = vi.fn()
  return {
    preview,
    apply,
    client: {
      admin: {
        previewProspectSizeProposals: { mutate: preview },
        applyProspectSizeProposals: { mutate: apply },
      },
    },
  }
})

vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))

import { ProspectSizeProposalReview } from './ProspectSizeProposalReview'

const proposed = {
  class: 'M',
  basis: 'seats',
  value: 1200,
  unit: 'seats',
  sourceUrl: 'https://venue.example/capacity',
  observedAt: '2026-09-25',
  confidence: 'measured' as const,
}

const rows = [
  {
    venueId: 'venue-ready',
    organizationId: 'org-ready',
    snapshotName: 'City History Museum',
    snapshotCity: 'Chicago',
    snapshotRegion: 'IL',
    currentName: 'City History Museum',
    currentCity: 'Chicago',
    currentRegion: 'IL',
    currentUpdatedAt: '2026-09-20T10:00:00.000Z',
    currentSize: 'UNKNOWN',
    currentSizeEvidence: null,
    proposedSize: proposed,
    status: 'READY' as const,
    reasons: [],
  },
  {
    venueId: 'venue-conflict',
    organizationId: 'org-conflict',
    snapshotName: 'Riverside Arena',
    snapshotCity: 'Evanston',
    snapshotRegion: 'IL',
    currentName: 'Riverside Arena',
    currentCity: 'Chicago',
    currentRegion: 'IL',
    currentUpdatedAt: '2026-09-26T10:00:00.000Z',
    currentSize: null,
    currentSizeEvidence: null,
    proposedSize: { ...proposed, class: 'XL', value: 12000 },
    status: 'CONFLICT' as const,
    reasons: ['Row version changed after research.'],
  },
]

function proposalFile() {
  const contents = JSON.stringify({
    schema: 'torchiko.prospect-size-proposals/v1',
    status: 'proposal-only',
    records: rows.map((row) => ({
      venueId: row.venueId,
      organizationId: row.organizationId,
      snapshotName: row.snapshotName,
      snapshotCity: row.snapshotCity,
      snapshotRegion: row.snapshotRegion,
      expectedUpdatedAt: null,
      size: row.proposedSize,
    })),
  })
  const file = new File([contents], 'sizes.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: async () => contents })
  return file
}

describe('ProspectSizeProposalReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.preview.mockResolvedValue({ rows })
    mocks.apply.mockResolvedValue({
      results: [
        {
          venueId: 'venue-ready',
          status: 'APPLIED',
          reasons: [],
          updatedAt: '2026-09-27T12:00:00.000Z',
          readbackSize: 'M',
        },
      ],
    })
  })

  afterEach(() => cleanup())

  it('rejects malformed proposal files before making a CRM request', async () => {
    render(<ProspectSizeProposalReview />)
    fireEvent.change(screen.getByLabelText('Choose a size proposal JSON file'), {
      target: { files: [new File(['{}'], 'wrong.json', { type: 'application/json' })] },
    })
    expect((await screen.findByRole('alert')).textContent).toMatch(/not valid JSON/)
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it('previews identity, current value, row version and conflict reasons; applies only selected ready rows and shows readback', async () => {
    render(<ProspectSizeProposalReview />)
    fireEvent.change(screen.getByLabelText('Choose a size proposal JSON file'), {
      target: { files: [proposalFile()] },
    })
    await screen.findByText(/2 records in sizes.json/)
    fireEvent.click(screen.getByRole('button', { name: 'Preview rows' }))

    expect(
      await screen.findByRole('heading', { name: '2. Review changes and conflicts' }),
    ).toBeTruthy()
    expect(mocks.preview).toHaveBeenCalledWith({
      proposalFile: expect.objectContaining({
        schema: 'torchiko.prospect-size-proposals/v1',
        status: 'proposal-only',
        records: expect.arrayContaining([
          expect.objectContaining({ venueId: 'venue-ready' }),
          expect.objectContaining({ venueId: 'venue-conflict' }),
        ]),
      }),
    })
    expect(
      screen.getByText(`Row version: ${new Date(rows[0]!.currentUpdatedAt!).toLocaleString()}`),
    ).toBeTruthy()
    expect(screen.getByText('Row version changed after research.')).toBeTruthy()
    expect(screen.getAllByText('Current size')[0]?.parentElement?.textContent).toContain('UNKNOWN')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select City History Museum' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected' }))
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1))
    expect(mocks.apply).toHaveBeenCalledWith({
      rows: [
        {
          venueId: 'venue-ready',
          organizationId: 'org-ready',
          expectedUpdatedAt: '2026-09-20T10:00:00.000Z',
          snapshotName: 'City History Museum',
          snapshotCity: 'Chicago',
          snapshotRegion: 'IL',
          size: proposed,
        },
      ],
    })
    expect(await screen.findByText('Read back: M')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/1 row applied and read back/)
  })
})
