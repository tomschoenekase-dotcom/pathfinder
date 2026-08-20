/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { ReviewedVenuePackageDraftForm } from './ReviewedVenuePackageDraftForm'

const mutate = vi.fn()
const supportMutate = vi.fn()
const candidateMutate = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createReviewedVenuePackageDraft: { mutate },
      createAndLinkSupportReviewedVenuePackageDraft: { mutate: supportMutate },
      createAndLinkIntakeCandidateDraft: { mutate: candidateMutate },
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
    const payload: NonNullable<
      inferRouterOutputs<AppRouter>['admin']['getIntakeVenuePackageCandidate']['payload']
    > = {
      schemaVersion: 3,
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [], update: [], delete: [] },
    }
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

  it('routes support context to its atomic create-and-link procedure', async () => {
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
  })

  it('fails closed when intake linkage has no server-reviewed candidate', () => {
    render(
      <ReviewedVenuePackageDraftForm tenantId="tenant_1" venueId="venue_1" intakeRunId="run_1" />,
    )
    expect(screen.getByText(/Load the server-reviewed intake candidate/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('VenuePackage payload JSON'), {
      target: { value: JSON.stringify({ schemaVersion: 1, places: [], knowledgeEntries: [] }) },
    })
    expect(
      (screen.getByRole('button', { name: 'Review exact payload' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Create DRAFT only' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    expect(candidateMutate).not.toHaveBeenCalled()
  })

  it('uses unique title and editor IDs when multiple candidate forms render together', () => {
    const candidate = {
      identity: 'STRUCTURED_BOOTSTRAP:run_1:a',
      expectedCandidateHash: 'a'.repeat(64),
      payload: {
        schemaVersion: 3 as const,
        places: { create: [], update: [], delete: [] },
        knowledgeEntries: { create: [], update: [], delete: [] },
      },
      source: {
        kind: 'STRUCTURED_BOOTSTRAP',
        label: 'structured onboarding proposal',
        evidenceCount: 1,
        discrepancyCount: 0,
        confidence: null,
      },
      warnings: [],
    }
    const { container } = render(
      <>
        <ReviewedVenuePackageDraftForm
          tenantId="tenant_1"
          venueId="venue_1"
          intakeRunId="run_1"
          prefillCandidate={candidate}
        />
        <ReviewedVenuePackageDraftForm
          tenantId="tenant_1"
          venueId="venue_1"
          intakeRunId="run_2"
          prefillCandidate={{
            ...candidate,
            identity: 'STRUCTURED_BOOTSTRAP:run_2:b',
            expectedCandidateHash: 'b'.repeat(64),
          }}
        />
      </>,
    )
    const sections = Array.from(container.querySelectorAll('section'))
    const editors = screen.getAllByLabelText('VenuePackage payload JSON') as HTMLTextAreaElement[]
    const titleIds = sections.map((section) => section.getAttribute('aria-labelledby'))
    const editorIds = editors.map((editor) => editor.id)

    expect(new Set(titleIds).size).toBe(2)
    expect(new Set(editorIds).size).toBe(2)
    expect(titleIds.every((id) => Boolean(id && container.ownerDocument.getElementById(id)))).toBe(
      true,
    )
    expect(editors.every((editor) => editor.labels?.length === 1)).toBe(true)
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
    await screen.findByText(/outcome could not be confirmed/iu)
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
    await act(async () => {
      rejectFirst(new Error('Response unavailable'))
    })
    await screen.findByText(/outcome could not be confirmed/iu)

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

  it('prefills a server candidate with evidence context but still requires explicit review', () => {
    const payload = {
      schemaVersion: 3 as const,
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [], update: [], delete: [] },
    }
    render(
      <ReviewedVenuePackageDraftForm
        tenantId="tenant_1"
        venueId="venue_1"
        prefillCandidate={{
          identity: 'INTERVIEW:run_1:candidate_hash',
          expectedCandidateHash: 'a'.repeat(64),
          payload,
          source: {
            kind: 'INTERVIEW',
            label: 'Staff interview',
            evidenceCount: 3,
            discrepancyCount: 0,
            confidence: 0.8,
          },
          warnings: ['Confirm seasonal hours before approval.'],
        }}
      />,
    )

    expect(screen.getByText('Candidate from Staff interview')).toBeTruthy()
    expect(screen.getByText(/3 evidence item/)).toBeTruthy()
    expect(screen.getByText(/Confirm seasonal hours/)).toBeTruthy()
    expect((screen.getByLabelText('VenuePackage payload JSON') as HTMLTextAreaElement).value).toBe(
      JSON.stringify(payload, null, 2),
    )
    expect(
      (screen.getByRole('button', { name: 'Create and link DRAFT only' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('keeps a server candidate read-only and submits only its hash to the rebuilding mutation', async () => {
    candidateMutate.mockResolvedValue({ value: { replayed: false }, attachment: {} })
    render(
      <ReviewedVenuePackageDraftForm
        tenantId="tenant_1"
        venueId="venue_1"
        intakeRunId="run_1"
        prefillCandidate={{
          identity: 'INTERVIEW:run_1:candidate_hash',
          expectedCandidateHash: 'a'.repeat(64),
          payload: {
            schemaVersion: 3,
            places: { create: [], update: [], delete: [] },
            knowledgeEntries: { create: [], update: [], delete: [] },
          },
          source: {
            kind: 'INTERVIEW',
            label: 'Staff interview',
            evidenceCount: 2,
            discrepancyCount: 0,
            confidence: null,
          },
          warnings: [],
        }}
      />,
    )
    expect(
      (screen.getByLabelText('VenuePackage payload JSON') as HTMLTextAreaElement).readOnly,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Review exact candidate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create and link DRAFT only' }))
    await waitFor(() => expect(candidateMutate).toHaveBeenCalledOnce())
    expect(candidateMutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      runId: 'run_1',
      expectedCandidateHash: 'a'.repeat(64),
    })
    expect(candidateMutate.mock.calls[0]?.[0]).not.toHaveProperty('draftKey')
    expect(candidateMutate.mock.calls[0]?.[0]).not.toHaveProperty('payload')
    const review = screen.getByRole('button', {
      name: 'Review exact candidate',
    }) as HTMLButtonElement
    const create = screen.getByRole('button', {
      name: 'Create and link DRAFT only',
    }) as HTMLButtonElement
    expect(review.disabled).toBe(true)
    expect(create.disabled).toBe(true)
    fireEvent.click(create)
    expect(candidateMutate).toHaveBeenCalledOnce()
  })

  it('keeps the same read-only candidate on rerender and resets for a different source identity', () => {
    const first = {
      identity: 'INTERVIEW:run_1:first',
      expectedCandidateHash: 'a'.repeat(64),
      payload: {
        schemaVersion: 3 as const,
        places: { create: [], update: [], delete: [] },
        knowledgeEntries: { create: [], update: [], delete: [] },
      },
      source: {
        kind: 'INTERVIEW',
        label: 'First interview',
        evidenceCount: 1,
        discrepancyCount: 0,
        confidence: 1,
      },
      warnings: [],
    }
    const { rerender } = render(
      <ReviewedVenuePackageDraftForm
        tenantId="tenant_1"
        venueId="venue_1"
        prefillCandidate={first}
      />,
    )
    const editor = screen.getByLabelText('VenuePackage payload JSON')
    const firstText = (editor as HTMLTextAreaElement).value

    rerender(
      <ReviewedVenuePackageDraftForm
        tenantId="tenant_1"
        venueId="venue_1"
        prefillCandidate={{ ...first }}
      />,
    )
    expect((editor as HTMLTextAreaElement).value).toBe(firstText)

    rerender(
      <ReviewedVenuePackageDraftForm
        tenantId="tenant_1"
        venueId="venue_1"
        prefillCandidate={{
          ...first,
          identity: 'STRUCTURED_BOOTSTRAP:run_2:second',
          expectedCandidateHash: 'b'.repeat(64),
          payload: {
            schemaVersion: 3,
            places: { create: [], update: [], delete: [] },
            knowledgeEntries: { create: [], update: [], delete: [] },
          },
          source: { ...first.source, kind: 'STRUCTURED_BOOTSTRAP', label: 'Bootstrap proposal' },
        }}
      />,
    )
    expect((editor as HTMLTextAreaElement).value).toBe(
      JSON.stringify(
        {
          schemaVersion: 3,
          places: { create: [], update: [], delete: [] },
          knowledgeEntries: { create: [], update: [], delete: [] },
        },
        null,
        2,
      ),
    )
  })
})
