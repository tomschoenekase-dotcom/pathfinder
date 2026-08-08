/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  list: vi.fn(),
  createDraft: vi.fn(),
  approve: vi.fn(),
  applyPackage: vi.fn(),
  revertPackage: vi.fn(),
}))

vi.mock('../lib/trpc', () => ({
  createTRPCClient: () => ({
    venuePackage: {
      preview: { mutate: mocks.preview },
      list: { query: mocks.list },
      createDraft: { mutate: mocks.createDraft },
      approve: { mutate: mocks.approve },
      applyPackage: { mutate: mocks.applyPackage },
      revertPackage: { mutate: mocks.revertPackage },
    },
  }),
}))

import { VenueJsonImporter } from './VenueJsonImporter'

const payload = {
  schemaVersion: 1,
  places: [
    {
      name: 'Butterfly Conservatory',
      type: 'exhibit',
      itemType: 'exhibit',
      shortDescription: 'Butterflies.',
      lat: 41.8,
      lng: -87.6,
      tags: ['family'],
      importanceScore: 80,
    },
  ],
  knowledgeEntries: [
    {
      title: 'Accessibility',
      category: 'Accessibility',
      content: 'Step-free entry.',
      isEnabled: true,
    },
  ],
}

const preview = {
  schemaVersion: 1,
  payloadHash: 'a'.repeat(64),
  baseDigest: 'b'.repeat(64),
  warningDigest: 'c'.repeat(64),
  mode: 'ADDITIVE_V1',
  report: { errors: [], warnings: [] },
  changes: {
    places: { add: payload.places, change: [], remove: [], unchanged: 2 },
    knowledgeEntries: { add: payload.knowledgeEntries, change: [], remove: [], unchanged: 3 },
  },
}

const updatedAt = new Date('2026-08-08T12:00:00.000Z')
const draft = {
  id: 'cpackageabc1234567890',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  schemaVersion: 1,
  payload,
  payloadHash: preview.payloadHash,
  baseDigest: preview.baseDigest,
  validationReport: preview.report,
  previewPlan: preview,
  status: 'DRAFT',
  createdBy: 'manager-1',
  approvedBy: null,
  approvedAt: null,
  appliedBy: null,
  appliedAt: null,
  appliedEntities: null,
  revertedBy: null,
  revertedAt: null,
  createdAt: updatedAt,
  updatedAt,
}

describe('venue package workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue([])
    mocks.preview.mockResolvedValue(preview)
  })

  afterEach(cleanup)

  it('uses the server preview and renders every supported addition exactly', async () => {
    render(
      <VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="location_aware" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))

    await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce())
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        payload: expect.objectContaining({ schemaVersion: 1 }),
      }),
    )
    expect(await screen.findByText(/"shortDescription": "Butterflies\."/)).toBeTruthy()
    expect(screen.getByText(/"lat": 41\.8,/)).toBeTruthy()
    expect(screen.getAllByText(/"tags": \[/).some((node) => node.tagName === 'PRE')).toBe(true)
    expect(screen.getByText(/"content": "Step-free entry\."/)).toBeTruthy()
    expect(screen.getAllByText(/"isEnabled": true/).some((node) => node.tagName === 'PRE')).toBe(
      true,
    )
    expect(screen.getByText(/2 existing places unchanged/)).toBeTruthy()
    expect(screen.getByText(/3 existing entries unchanged/)).toBeTruthy()
  })

  it('shows strict server rejection and performs no draft or lifecycle write', async () => {
    mocks.preview.mockRejectedValueOnce(
      new Error('payload.tours: Unrecognized key; schemaVersion 1 does not support tours'),
    )
    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.change(screen.getByLabelText('Canonical package JSON'), {
      target: {
        value: JSON.stringify({
          schemaVersion: 1,
          places: [],
          knowledgeEntries: [],
          tours: [],
        }),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))

    expect((await screen.findByRole('alert')).textContent).toContain('does not support tours')
    expect(mocks.createDraft).not.toHaveBeenCalled()
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.applyPackage).not.toHaveBeenCalled()
  })

  it('requires warning acknowledgement before a saved draft can be approved', async () => {
    const warningPreview = {
      ...preview,
      warningDigest: 'd'.repeat(64),
      report: {
        errors: [],
        warnings: [
          {
            code: 'DUPLICATE_EXISTING_CONTENT',
            path: 'places.0.name',
            message: 'An active venue place already has this normalized name.',
          },
        ],
      },
    }
    mocks.preview.mockResolvedValue(warningPreview)
    mocks.createDraft.mockResolvedValue({
      ...draft,
      validationReport: warningPreview.report,
      preview: warningPreview,
      replayed: false,
    })
    mocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...draft, validationReport: warningPreview.report }])
      .mockResolvedValueOnce([
        { ...draft, status: 'APPROVED', validationReport: warningPreview.report },
      ])
    mocks.approve.mockResolvedValue({ ...draft, status: 'APPROVED' })

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview on server' }))
    expect(await screen.findByText(/already has this normalized name/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save immutable draft' }))
    expect(await screen.findByText('Draft saved for review.')).toBeTruthy()
    expect(mocks.preview).toHaveBeenCalledTimes(2)

    const approve = screen.getByRole('button', { name: 'Approve' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((approve as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(approve)

    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith({
        id: draft.id,
        expectedUpdatedAt: updatedAt,
        commandKey: expect.any(String),
        acknowledgedWarningDigest: warningPreview.warningDigest,
        acknowledgedPayloadHash: warningPreview.payloadHash,
      }),
    )
    expect(await screen.findByText(/Application remains a separate action/)).toBeTruthy()
  })

  it('keeps apply and confirmed aggregate revert as separate lifecycle actions', async () => {
    const approved = { ...draft, status: 'APPROVED' }
    const applied = { ...draft, status: 'APPLIED', updatedAt: new Date(updatedAt.getTime() + 1) }
    mocks.list
      .mockResolvedValueOnce([approved])
      .mockResolvedValueOnce([applied])
      .mockResolvedValueOnce([{ ...applied, status: 'REVERTED' }])
    mocks.applyPackage.mockResolvedValue(applied)
    mocks.revertPackage.mockResolvedValue({ ...applied, status: 'REVERTED' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<VenueJsonImporter venueId="venue-1" venueName="City Museum" guideMode="non_location" />)
    fireEvent.click(await screen.findByText(draft.id))
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved package' }))
    await waitFor(() =>
      expect(mocks.applyPackage).toHaveBeenCalledWith({
        id: draft.id,
        expectedUpdatedAt: updatedAt,
        commandKey: expect.any(String),
      }),
    )
    expect(await screen.findByText('Package applied atomically.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Revert package' }))
    await waitFor(() =>
      expect(mocks.revertPackage).toHaveBeenCalledWith({
        id: draft.id,
        expectedUpdatedAt: applied.updatedAt,
        commandKey: expect.any(String),
      }),
    )
    expect(window.confirm).toHaveBeenCalled()
  })
})
