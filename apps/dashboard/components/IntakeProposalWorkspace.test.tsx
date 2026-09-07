/* @vitest-environment jsdom */
import React, { createRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STAFF_INTERVIEW_CONSENT_TEXT } from '@pathfinder/contracts/staff-interview'

const mocks = vi.hoisted(() => {
  const values = {
    mutate: vi.fn(),
    adminMutate: vi.fn(),
    draftQuery: vi.fn(),
    draftSave: vi.fn(),
    refresh: vi.fn(),
  }
  const client = {
    intake: {
      createProposal: { mutate: values.mutate },
      getSubmissionDraft: { query: values.draftQuery },
      saveSubmissionDraft: { mutate: values.draftSave },
    },
    admin: { createIntakeProposal: { mutate: values.adminMutate } },
  }
  return { ...values, client, currentClient: client }
})
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => mocks.currentClient,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
import {
  IntakeProposalWorkspace,
  type IntakeProposalWorkspaceController,
} from './IntakeProposalWorkspace'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}

describe('IntakeProposalWorkspace', () => {
  beforeEach(() => {
    mocks.currentClient = mocks.client
    mocks.draftQuery.mockResolvedValue(null)
    mocks.draftSave.mockResolvedValue({ id: 'draft-1', revision: 1, updatedAt: new Date() })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })
  it('shares staff answers with client-safe language and no implementation identifiers', async () => {
    mocks.mutate.mockResolvedValue({ id: 'run-1' })
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Staff questionnaire'))
    fireEvent.change(screen.getByLabelText('Interview name'), {
      target: { value: 'Staff interview' },
    })
    fireEvent.change(screen.getAllByLabelText('Written answer')[0]!, {
      target: { value: 'Hours are nine to five.' },
    })
    fireEvent.click(screen.getAllByLabelText('Explicitly skip')[1]!)
    fireEvent.click(screen.getAllByLabelText('Redact')[2]!)
    fireEvent.click(screen.getByLabelText(STAFF_INTERVIEW_CONSENT_TEXT))
    fireEvent.click(screen.getByRole('button', { name: 'Share staff answers' }))
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        venueId: 'venue-1',
        draftRevision: 1,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: 'INTERVIEW',
        displayName: 'Staff interview',
        submission: {
          role: 'EXECUTIVE',
          consentToUse: true,
          acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
          answers: [
            {
              questionId: 'executive.mission',
              text: 'Hours are nine to five.',
              privacy: 'PUBLIC_CANDIDATE',
              skipped: false,
              redacted: false,
              uncertain: false,
              confidence: 0.8,
            },
            {
              questionId: 'executive.priorities',
              privacy: 'PUBLIC_CANDIDATE',
              skipped: true,
              redacted: false,
              uncertain: false,
              confidence: 0.8,
            },
            {
              questionId: 'executive.internal-risks',
              privacy: 'INTERNAL_CONTEXT',
              skipped: false,
              redacted: true,
              uncertain: false,
              confidence: 0.8,
            },
          ],
        },
      }),
    )
    expect(await screen.findByText(/Information received/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /proposal|package|handoff|manifest|hash|quarantin/iu,
    )
  })

  it('does not offer a public classification for private-by-default questions', () => {
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Staff questionnaire'))
    fireEvent.change(screen.getByLabelText('Staff role'), { target: { value: 'OPERATIONS' } })
    const classifications = screen.getAllByLabelText('Privacy', {
      selector: 'select',
    })
    const classification = classifications.at(-1) as HTMLSelectElement
    expect(Array.from(classification.options).map((option) => option.value)).toEqual(['PRIVATE'])
  })

  it('shares optional notes as a review-only source with useful guidance', async () => {
    mocks.mutate.mockResolvedValue({ id: 'run-notes' })
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Optional notes'))
    expect(screen.getByText(/hours exceptions, accessibility details, visitor tips/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Notes'), {
      target: { value: 'The east entrance is step-free.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Share notes' }))
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        venueId: 'venue-1',
        draftRevision: 1,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: 'NOTES',
        notes: 'The east entrance is step-free.',
      }),
    )
    expect(await screen.findByText(/Information received/)).toBeTruthy()
  })

  it('preserves unfinished website and notes drafts while switching source types', () => {
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.change(screen.getByLabelText('Website name'), {
      target: { value: 'Museum website' },
    })
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://museum.example' },
    })

    fireEvent.click(screen.getByLabelText('Optional notes'))
    fireEvent.change(screen.getByLabelText('Notes'), {
      target: { value: 'The east entrance is step-free.' },
    })
    fireEvent.click(screen.getByLabelText('Website'))

    expect((screen.getByLabelText('Website name') as HTMLInputElement).value).toBe('Museum website')
    expect((screen.getByLabelText('Website URL') as HTMLInputElement).value).toBe(
      'https://museum.example',
    )
    fireEvent.click(screen.getByLabelText('Optional notes'))
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe(
      'The east entrance is step-free.',
    )
  })

  it('resumes the authenticated user website draft returned by the server', async () => {
    mocks.draftQuery.mockImplementation(async ({ sourceKind }: { sourceKind: string }) =>
      sourceKind === 'WEBSITE'
        ? {
            content: {
              kind: 'WEBSITE',
              displayName: 'Saved museum site',
              websiteUri: 'https://saved.example',
            },
            revision: 7,
            submittedAt: null,
          }
        : null,
    )
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    expect(await screen.findByDisplayValue('Saved museum site')).toBeTruthy()
    expect(screen.getByDisplayValue('https://saved.example')).toBeTruthy()
  })

  it('shows a visible conflict and retains local edits when another device wins', async () => {
    mocks.draftSave.mockRejectedValue(new Error('Draft state changed; reload before saving.'))
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Optional notes'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Keep this local text.' } })
    expect(await screen.findByText(/changed elsewhere/)).toBeTruthy()
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe(
      'Keep this local text.',
    )
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('persists clearing the final saved value instead of resurrecting it on reload', async () => {
    mocks.draftQuery.mockImplementation(async ({ sourceKind }: { sourceKind: string }) =>
      sourceKind === 'NOTES'
        ? { content: { kind: 'NOTES', notes: 'Remove me' }, revision: 2, submittedAt: null }
        : null,
    )
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Optional notes'))
    const notes = await screen.findByDisplayValue('Remove me')
    fireEvent.change(notes, { target: { value: '' } })

    await waitFor(() =>
      expect(mocks.draftSave).toHaveBeenCalledWith(
        expect.objectContaining({
          venueId: 'venue-1',
          sourceKind: 'NOTES',
          content: { kind: 'NOTES', notes: '' },
          expectedRevision: 2,
        }),
      ),
    )
  })

  it('serializes slow saves for one source and advances the expected revision', async () => {
    const first = deferred<{ id: string; revision: number; updatedAt: Date }>()
    mocks.draftSave
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ id: 'draft-1', revision: 2, updatedAt: new Date() })
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Optional notes'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'First' } })
    await waitFor(() => expect(mocks.draftSave).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Second' } })
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(mocks.draftSave).toHaveBeenCalledTimes(1)

    first.resolve({ id: 'draft-1', revision: 1, updatedAt: new Date() })
    await waitFor(() => expect(mocks.draftSave).toHaveBeenCalledTimes(2))
    expect(mocks.draftSave.mock.calls[1]![0]).toMatchObject({
      content: { kind: 'NOTES', notes: 'Second' },
      expectedRevision: 1,
    })
  })

  it('cancels a pending venue draft timer and fences a late old-venue response', async () => {
    const rendered = render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Optional notes'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Old venue' } })
    rendered.rerender(<IntakeProposalWorkspace venueId="venue-2" proposals={[]} />)
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(mocks.draftSave).not.toHaveBeenCalled()
    expect(mocks.draftQuery).toHaveBeenCalledWith({ venueId: 'venue-2', sourceKind: 'NOTES' })
  })

  it('flushes a pending private draft once and returns its exact saved revision', async () => {
    const controller = createRef<IntakeProposalWorkspaceController>()
    mocks.draftSave.mockResolvedValue({ id: 'draft-1', revision: 8, updatedAt: new Date() })
    render(<IntakeProposalWorkspace ref={controller} venueId="venue-1" proposals={[]} />)
    await screen.findByText('Share more information')
    fireEvent.click(screen.getByLabelText('Optional notes'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Private pending note' } })

    const first = controller.current!.prepareV1Drafts()
    const second = controller.current!.prepareV1Drafts()
    expect(second).toBe(first)
    await expect(first).resolves.toEqual([{ sourceKind: 'NOTES', expectedRevision: 8 }])
    expect(mocks.draftSave).toHaveBeenCalledTimes(1)
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('returns all three already saved private draft revisions in stable source order', async () => {
    const controller = createRef<IntakeProposalWorkspaceController>()
    mocks.draftQuery.mockImplementation(async ({ sourceKind }: { sourceKind: string }) => ({
      content:
        sourceKind === 'WEBSITE'
          ? { kind: 'WEBSITE', displayName: 'Museum', websiteUri: 'https://museum.example' }
          : sourceKind === 'INTERVIEW'
            ? {
                kind: 'INTERVIEW',
                displayName: 'Staff knowledge',
                role: 'EXECUTIVE',
                consent: false,
                draftsByRole: {},
              }
            : { kind: 'NOTES', notes: 'Private notes' },
      revision: sourceKind === 'WEBSITE' ? 4 : sourceKind === 'INTERVIEW' ? 5 : 6,
      submittedAt: null,
    }))
    render(<IntakeProposalWorkspace ref={controller} venueId="venue-1" proposals={[]} />)
    await screen.findByDisplayValue('Museum')

    await expect(controller.current!.prepareV1Drafts()).resolves.toEqual([
      { sourceKind: 'WEBSITE', expectedRevision: 4 },
      { sourceKind: 'INTERVIEW', expectedRevision: 5 },
      { sourceKind: 'NOTES', expectedRevision: 6 },
    ])
    expect(mocks.draftSave).not.toHaveBeenCalled()
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('rejects preparation while drafts are loading or conflicted', async () => {
    const loading = deferred<null>()
    const controller = createRef<IntakeProposalWorkspaceController>()
    mocks.draftQuery.mockReturnValue(loading.promise)
    render(<IntakeProposalWorkspace ref={controller} venueId="venue-1" proposals={[]} />)
    await expect(controller.current!.prepareV1Drafts()).rejects.toThrow(/still loading/i)
    loading.resolve(null)
    await screen.findByText('Share more information')

    mocks.draftSave.mockRejectedValue(new Error('Draft state changed; conflict.'))
    fireEvent.click(screen.getByLabelText('Optional notes'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Keep this text' } })
    await screen.findByText(/changed elsewhere/)
    await expect(controller.current!.prepareV1Drafts()).rejects.toThrow(/changed elsewhere/i)
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('rejects a late save result after the venue scope changes', async () => {
    const controller = createRef<IntakeProposalWorkspaceController>()
    const save = deferred<{ id: string; revision: number; updatedAt: Date }>()
    mocks.draftSave.mockReturnValue(save.promise)
    const rendered = render(
      <IntakeProposalWorkspace ref={controller} venueId="venue-1" proposals={[]} />,
    )
    await screen.findByText('Share more information')
    fireEvent.click(screen.getByLabelText('Optional notes'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Old venue text' } })
    const preparation = controller.current!.prepareV1Drafts()
    rendered.rerender(<IntakeProposalWorkspace ref={controller} venueId="venue-2" proposals={[]} />)
    save.resolve({ id: 'draft-old', revision: 3, updatedAt: new Date() })

    await expect(preparation).rejects.toThrow(/scope changed/i)
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('reloads drafts from a replaced client and returns only the replacement revision', async () => {
    const controller = createRef<IntakeProposalWorkspaceController>()
    mocks.draftQuery.mockImplementation(async ({ sourceKind }: { sourceKind: string }) =>
      sourceKind === 'NOTES'
        ? { content: { kind: 'NOTES', notes: 'First client' }, revision: 2, submittedAt: null }
        : null,
    )
    const rendered = render(
      <IntakeProposalWorkspace ref={controller} venueId="venue-1" proposals={[]} />,
    )
    await screen.findByDisplayValue('First client')
    await expect(controller.current!.prepareV1Drafts()).resolves.toEqual([
      { sourceKind: 'NOTES', expectedRevision: 2 },
    ])

    const replacementQuery = vi.fn(async ({ sourceKind }: { sourceKind: string }) =>
      sourceKind === 'NOTES'
        ? {
            content: { kind: 'NOTES', notes: 'Replacement client' },
            revision: 9,
            submittedAt: null,
          }
        : null,
    )
    mocks.currentClient = {
      ...mocks.client,
      intake: {
        ...mocks.client.intake,
        getSubmissionDraft: { query: replacementQuery },
      },
    }
    rendered.rerender(<IntakeProposalWorkspace ref={controller} venueId="venue-1" proposals={[]} />)
    await screen.findByDisplayValue('Replacement client')
    await expect(controller.current!.prepareV1Drafts()).resolves.toEqual([
      { sourceKind: 'NOTES', expectedRevision: 9 },
    ])
    expect(replacementQuery).toHaveBeenCalledTimes(3)
  })

  it('rejects an empty preparation through a retained controller after unmount', async () => {
    const controller = createRef<IntakeProposalWorkspaceController>()
    const rendered = render(
      <IntakeProposalWorkspace ref={controller} venueId="venue-1" proposals={[]} />,
    )
    await waitFor(() => expect(mocks.draftQuery).toHaveBeenCalledTimes(3))
    const retainedController = controller.current!
    await expect(retainedController.prepareV1Drafts()).resolves.toEqual([])
    rendered.unmount()

    await expect(retainedController.prepareV1Drafts()).rejects.toThrow(/scope changed/i)
  })

  it('disables editing and sharing while a parent reviews the frozen selection', async () => {
    render(<IntakeProposalWorkspace suspendEditing venueId="venue-1" proposals={[]} />)
    await screen.findByText('Share more information')
    expect(screen.getByLabelText('Website name').matches(':disabled')).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Share website' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.queryByText('Sharing…')).toBeNull()
  })

  it('rejects preparation while an individual source submit is in flight', async () => {
    const controller = createRef<IntakeProposalWorkspaceController>()
    const submission = deferred<{ id: string }>()
    mocks.mutate.mockReturnValue(submission.promise)
    render(<IntakeProposalWorkspace ref={controller} venueId="venue-1" proposals={[]} />)
    fireEvent.change(screen.getByLabelText('Website name'), { target: { value: 'Museum' } })
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://museum.example' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Share website' }))

    expect(screen.getByRole('button', { name: 'Sharing…' })).toBeTruthy()

    await expect(controller.current!.prepareV1Drafts()).rejects.toThrow(/currently being shared/i)
    submission.resolve({ id: 'run-1' })
    await screen.findByText(/Information received/)
  })

  it('preserves separate staff answers when changing roles and source types', () => {
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Staff questionnaire'))
    fireEvent.change(screen.getByLabelText('Interview name'), {
      target: { value: 'Leadership and operations' },
    })
    fireEvent.change(screen.getAllByLabelText('Written answer')[0]!, {
      target: { value: 'Executive answer' },
    })
    fireEvent.change(screen.getByLabelText('Staff role'), { target: { value: 'OPERATIONS' } })
    fireEvent.change(screen.getAllByLabelText('Written answer')[0]!, {
      target: { value: 'Operations answer' },
    })

    fireEvent.click(screen.getByLabelText('Website'))
    fireEvent.click(screen.getByLabelText('Staff questionnaire'))
    fireEvent.change(screen.getByLabelText('Staff role'), { target: { value: 'EXECUTIVE' } })
    expect((screen.getAllByLabelText('Written answer')[0] as HTMLTextAreaElement).value).toBe(
      'Executive answer',
    )
    fireEvent.change(screen.getByLabelText('Staff role'), { target: { value: 'OPERATIONS' } })
    expect((screen.getAllByLabelText('Written answer')[0] as HTMLTextAreaElement).value).toBe(
      'Operations answer',
    )
  })

  it('warns before leaving with unfinished work and clears the warning after success', async () => {
    mocks.mutate.mockResolvedValue({ id: 'run-website' })
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.change(screen.getByLabelText('Website name'), {
      target: { value: 'Museum website' },
    })
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://museum.example' },
    })

    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Share website' }))
    await screen.findByText(/Information received/)
    await waitFor(() =>
      expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true),
    )
  })

  it('has no automated accessibility violations across the real source chooser', async () => {
    document.documentElement.lang = 'en'
    document.title = 'Torchiko onboarding source draft'
    render(<IntakeProposalWorkspace venueId="venue-1" proposals={[]} />)
    fireEvent.click(screen.getByLabelText('Staff questionnaire'))
    const result = await axe.run(document, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(
      result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
    ).toEqual([])
  })

  it('keeps package identity and operator workflow language out of client history', () => {
    render(
      <IntakeProposalWorkspace
        venueId="venue-1"
        proposals={[
          {
            id: 'intake-secret-id',
            sourceKind: 'WEBSITE',
            status: 'AWAITING_REVIEW',
            displayName: 'Venue website',
            websiteUri: 'https://example.com',
            interviewRole: null,
            createdAt: new Date('2026-08-10T12:00:00.000Z'),
            _count: { evidence: 8, events: 3 },
            packageHandoff: {
              packageDraftId: 'package-secret-id',
              createdAt: new Date('2026-08-10T13:00:00.000Z'),
            },
          },
        ]}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Information shared' })).toBeTruthy()
    expect(screen.getByText(/Prepared for Torchiko review/)).toBeTruthy()
    expect(screen.getByLabelText('Website name')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /package-secret-id|intake-secret-id|draft package|handoff|proposal history|evidence record/iu,
    )
  })

  it('fences same-tick duplicate submits and retains the request identity for an exact retry', async () => {
    let rejectFirst!: (error: Error) => void
    mocks.adminMutate
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockResolvedValueOnce({ id: 'run-admin' })
    render(<IntakeProposalWorkspace adminTenantId="tenant-1" venueId="venue-1" proposals={[]} />)
    fireEvent.change(screen.getByLabelText('Proposal name'), { target: { value: 'Venue site' } })
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://example.com' },
    })
    const submit = screen.getByRole('button', { name: 'Record website proposal' })
    fireEvent.click(submit)
    fireEvent.submit(submit.closest('form')!)
    expect(mocks.adminMutate).toHaveBeenCalledTimes(1)
    const firstRequestId = mocks.adminMutate.mock.calls[0]?.[0].requestId
    rejectFirst(new Error('Ambiguous response'))
    await screen.findByText(/Ambiguous response/)
    fireEvent.click(screen.getByRole('button', { name: 'Record website proposal' }))
    await waitFor(() => expect(mocks.adminMutate).toHaveBeenCalledTimes(2))
    expect(mocks.adminMutate.mock.calls[1]?.[0].requestId).toBe(firstRequestId)
  })

  it('serializes operator-assisted website intake through the platform-admin adapter', async () => {
    mocks.adminMutate.mockResolvedValue({ id: 'run-admin' })
    render(<IntakeProposalWorkspace adminTenantId="tenant-1" venueId="venue-1" proposals={[]} />)
    fireEvent.change(screen.getByLabelText('Proposal name'), { target: { value: 'Venue site' } })
    fireEvent.change(screen.getByLabelText('Website URL'), {
      target: { value: 'https://example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record website proposal' }))
    await waitFor(() =>
      expect(mocks.adminMutate).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: 'WEBSITE',
        displayName: 'Venue site',
        websiteUri: 'https://example.com',
      }),
    )
    expect(mocks.mutate).not.toHaveBeenCalled()
  })
})
