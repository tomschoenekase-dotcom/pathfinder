/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const mutate = vi.fn()
const mutateOperational = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      previewSemanticVenueUpdate: { query },
      createSemanticVenueUpdatePackageDraft: { mutate },
      createSemanticOperationalUpdateDraft: { mutate: mutateOperational },
    },
  }),
}))

import { SemanticUpdatePreview } from './SemanticUpdatePreview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('SemanticUpdatePreview', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('computes and renders one correction without publication controls', async () => {
    query.mockResolvedValue({
      classification: 'CORRECTION',
      operationCount: 1,
      authority: 'TRUSTED_PARTNER',
      confidence: 0.95,
      blockers: [],
      questions: [],
      proposalStatus: 'APPROVED',
      previewHash: 'a'.repeat(64),
      venuePackagePatch: { schemaVersion: 3 },
    })
    mutate.mockResolvedValue({ packageId: 'package-a', packageStatus: 'DRAFT', replayed: false })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'HOURS' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Museum hours' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 9–5 daily.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))

    expect(await screen.findByText('CORRECTION')).toBeTruthy()
    expect(screen.getByText('1 proposed operation')).toBeTruthy()
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        relation: 'CORRECTS',
        desired: expect.objectContaining({ content: 'Open 9–5 daily.' }),
      }),
    )
    expect(screen.queryByRole('button', { name: /approve|apply|publish/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create reviewable package DRAFT' }))
    expect(await screen.findByText(/Created DRAFT/)).toBeTruthy()
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPreviewHash: 'a'.repeat(64),
        relation: 'CORRECTS',
      }),
    )
    expect(screen.getByRole('link', { name: 'Open package review' }).getAttribute('href')).toBe(
      '/admin/clients/tenant-a/venues/venue-a/packages',
    )
  })

  it('invalidates a computed preview when structured content changes', async () => {
    query.mockResolvedValue({
      classification: 'CORRECTION',
      operationCount: 1,
      authority: 'TRUSTED_PARTNER',
      confidence: 0.95,
      blockers: [],
      questions: [],
      proposalStatus: 'APPROVED',
      previewHash: 'a'.repeat(64),
      venuePackagePatch: { schemaVersion: 3 },
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'HOURS' } })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Museum hours' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 9–5 daily.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))
    expect(
      await screen.findByRole('button', { name: 'Create reviewable package DRAFT' }),
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Open 10–6 daily.' },
    })
    expect(screen.queryByRole('button', { name: 'Create reviewable package DRAFT' })).toBeNull()
  })

  it('creates a separate inactive operational DRAFT for a temporal preview', async () => {
    query.mockResolvedValue({
      classification: 'TEMPORAL',
      operationCount: 1,
      authority: 'TRUSTED_PARTNER',
      confidence: 0.95,
      blockers: [],
      questions: [],
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      venuePackagePatch: null,
      operationalUpdateDraft: { status: 'DRAFT' },
    })
    mutateOperational.mockResolvedValue({
      operationalUpdateId: 'update-a',
      operationalUpdateStatus: 'DRAFT',
      replayed: false,
    })
    render(
      <SemanticUpdatePreview
        tenantId="tenant-a"
        venueId="venue-a"
        proposalId="11111111-1111-4111-8111-111111111111"
        proposalUpdatedAt="2026-08-25T13:00:00.000Z"
        hasTarget={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Build semantic change preview' }))
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'TEMPORARY_CLOSURE' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing title'), {
      target: { value: 'Atrium closure' },
    })
    fireEvent.change(screen.getByLabelText('Visitor-facing content'), {
      target: { value: 'Closed for maintenance.' },
    })
    fireEvent.click(screen.getByLabelText('Time-bounded operational fact'))
    fireEvent.change(screen.getByLabelText('Starts at'), {
      target: { value: '2030-01-01T08:00' },
    })
    fireEvent.change(screen.getByLabelText('Expires at'), {
      target: { value: '2030-01-01T12:00' },
    })
    fireEvent.change(screen.getByLabelText('Operational update type'), {
      target: { value: 'TEMPORARY_CLOSURE' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compute semantic preview' }))

    expect(await screen.findByText('TEMPORAL')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create operational update DRAFT' }))
    expect(await screen.findByText(/Created DRAFT/)).toBeTruthy()
    expect(mutateOperational).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPreviewHash: 'b'.repeat(64),
        operationalUpdateType: 'TEMPORARY_CLOSURE',
        validFrom: new Date('2030-01-01T08:00').toISOString(),
        validUntil: new Date('2030-01-01T12:00').toISOString(),
      }),
    )
    expect(screen.queryByRole('button', { name: /schedule|publish/i })).toBeNull()
  })
})
