/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { ReviewedVenuePackageDraftForm } from './ReviewedVenuePackageDraftForm'

const mutate = vi.fn()
const supportMutate = vi.fn()
const intakeMutate = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createReviewedVenuePackageDraft: { mutate },
      createAndLinkSupportReviewedVenuePackageDraft: { mutate: supportMutate },
      createAndLinkIntakeReviewedVenuePackageDraft: { mutate: intakeMutate },
    },
  }),
}))

describe('ReviewedVenuePackageDraftForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('requires explicit review and submits only canonical DRAFT creation', async () => {
    mutate.mockResolvedValue({ value: { replayed: false }, attachment: { replayed: false } })
    render(<ReviewedVenuePackageDraftForm tenantId="tenant_1" venueId="venue_1" />)
    expect(screen.getByText(/canonical gated semantic-analysis pipeline/i)).toBeTruthy()
    const create = screen.getByRole('button', { name: 'Create DRAFT only' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    const payload = { schemaVersion: 1, places: [], knowledgeEntries: [] }
    fireEvent.change(screen.getByLabelText('VenuePackage payload JSON'), {
      target: { value: JSON.stringify(payload) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review exact payload' }))
    expect(screen.getByLabelText('Reviewed VenuePackage payload')).toBeTruthy()
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1', payload }),
    )
    expect(await screen.findByText(/complete semantic evidence/i)).toBeTruthy()
  })

  it('invalidates review when edited and never submits malformed JSON', () => {
    render(<ReviewedVenuePackageDraftForm tenantId="tenant_1" venueId="venue_1" />)
    const editor = screen.getByLabelText('VenuePackage payload JSON')
    fireEvent.change(editor, { target: { value: '{bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review exact payload' }))
    expect(screen.getByText(/Enter valid VenuePackage JSON/)).toBeTruthy()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('routes support and intake contexts to atomic create-and-link procedures', async () => {
    supportMutate.mockResolvedValue({ value: { replayed: false }, attachment: {} })
    const { unmount } = render(
      <ReviewedVenuePackageDraftForm
        tenantId="tenant_1"
        venueId="venue_1"
        support={{ requestId: 'support_1', expectedVersion: 4 }}
      />,
    )
    fireEvent.change(screen.getByLabelText('VenuePackage payload JSON'), {
      target: { value: JSON.stringify({ schemaVersion: 1, places: [], knowledgeEntries: [] }) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review exact payload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create DRAFT only' }))
    await waitFor(() => expect(supportMutate).toHaveBeenCalledOnce())
    expect(supportMutate).toHaveBeenCalledWith(
      expect.objectContaining({ supportRequestId: 'support_1', expectedVersion: 4 }),
    )
    unmount()

    intakeMutate.mockResolvedValue({ value: { replayed: false }, attachment: {} })
    render(
      <ReviewedVenuePackageDraftForm tenantId="tenant_1" venueId="venue_1" intakeRunId="run_1" />,
    )
    fireEvent.change(screen.getByLabelText('VenuePackage payload JSON'), {
      target: { value: JSON.stringify({ schemaVersion: 1, places: [], knowledgeEntries: [] }) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review exact payload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create DRAFT only' }))
    await waitFor(() => expect(intakeMutate).toHaveBeenCalledOnce())
    expect(intakeMutate).toHaveBeenCalledWith(expect.objectContaining({ intakeRunId: 'run_1' }))
  })

  it('retains the exact draft request key across an ambiguous retry', async () => {
    mutate.mockRejectedValueOnce(new Error('Response unavailable')).mockResolvedValueOnce({
      value: { replayed: true },
      attachment: { replayed: true },
    })
    render(<ReviewedVenuePackageDraftForm tenantId="tenant_1" venueId="venue_1" />)
    fireEvent.change(screen.getByLabelText('VenuePackage payload JSON'), {
      target: { value: JSON.stringify({ schemaVersion: 1, places: [], knowledgeEntries: [] }) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review exact payload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create DRAFT only' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    const firstKey = mutate.mock.calls[0]?.[0].draftKey
    fireEvent.click(screen.getByRole('button', { name: 'Create DRAFT only' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]?.[0].draftKey).toBe(firstKey)
    expect(await screen.findByText(/existing DRAFT was reconciled/i)).toBeTruthy()
  })

  it('synchronously fences same-tick submission and rotates identity after an edited failure', async () => {
    let rejectFirst!: (reason: Error) => void
    mutate.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject
      }),
    )
    render(<ReviewedVenuePackageDraftForm tenantId="tenant_1" venueId="venue_1" />)
    const editor = screen.getByLabelText('VenuePackage payload JSON')
    fireEvent.change(editor, {
      target: { value: JSON.stringify({ schemaVersion: 1, places: [], knowledgeEntries: [] }) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review exact payload' }))
    const create = screen.getByRole('button', { name: 'Create DRAFT only' })
    fireEvent.click(create)
    fireEvent.click(create)
    expect(mutate).toHaveBeenCalledTimes(1)
    const firstKey = mutate.mock.calls[0]?.[0].draftKey
    rejectFirst(new Error('Response unavailable'))
    await screen.findByText('Response unavailable')

    fireEvent.change(editor, {
      target: {
        value: JSON.stringify({
          schemaVersion: 1,
          places: [],
          knowledgeEntries: [
            { title: 'Changed', category: 'FAQ', content: 'Changed.', isEnabled: true },
          ],
        }),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Review exact payload' }))
    mutate.mockResolvedValueOnce({ value: { replayed: false }, attachment: {} })
    fireEvent.click(screen.getByRole('button', { name: 'Create DRAFT only' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]?.[0].draftKey).not.toBe(firstKey)
  })
})
