/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  listRequests: vi.fn(),
  getRequest: vi.fn(),
  createRequest: vi.fn(),
  addMessage: vi.fn(),
  listEligibleAttachments: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    support: {
      listRequests: { query: mocks.listRequests },
      getRequest: { query: mocks.getRequest },
      createRequest: { mutate: mocks.createRequest },
      addMessage: { mutate: mocks.addMessage },
      listEligibleAttachments: { query: mocks.listEligibleAttachments },
    },
  }),
}))

import { SupportWorkspace } from './SupportWorkspace'

const venue = { id: 'venue_alpha', name: 'Science Museum' }
const otherVenue = { id: 'venue_beta', name: 'History Center' }
const eligible = [
  {
    intakeUploadId: 'upload_alpha',
    fileName: 'visitor-hours.pdf',
    mimeType: 'application/pdf',
    byteSize: 2048,
    createdAt: '2026-08-10T13:00:00.000Z',
  },
]
const request = {
  id: 'request_1',
  venueId: venue.id,
  category: 'GENERAL',
  status: 'OPEN',
  subject: 'Update our opening time',
  missingInformation: [],
  version: 4,
  statusChangedAt: '2026-08-10T14:00:00.000Z',
  createdAt: '2026-08-10T14:00:00.000Z',
  updatedAt: '2026-08-10T15:00:00.000Z',
}
const clientMessage = {
  id: 'message_1',
  authorKind: 'CLIENT',
  visibility: 'CLIENT_VISIBLE' as const,
  body: 'We now open at nine.',
  createdAt: '2026-08-10T14:00:00.000Z',
  attachments: [],
}
const detail = { ...request, messages: [clientMessage], nextMessageCursor: null }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderWorkspace(overrides: Partial<React.ComponentProps<typeof SupportWorkspace>> = {}) {
  return render(
    <SupportWorkspace
      venues={[venue]}
      activeVenue={venue}
      initialRequests={[request]}
      initialNextCursor={null}
      initialDetail={detail}
      initialEligibleAttachments={[]}
      initialEligibleAttachmentsNextCursor={null}
      {...overrides}
    />,
  )
}

describe('SupportWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listRequests.mockResolvedValue({ items: [], nextCursor: null })
    mocks.getRequest.mockResolvedValue(detail)
  })

  afterEach(cleanup)

  it('keeps a single venue implicit and defensively renders only client-visible conversation data', () => {
    const adversarialDetail = {
      ...detail,
      internalNotes: 'INTERNAL ONLY: call the worker',
      artifacts: { patch: 'secret patch' },
      analytics: { cost: 99 },
      messages: [
        clientMessage,
        {
          ...clientMessage,
          id: 'message_internal',
          visibility: 'INTERNAL',
          body: 'Internal worker note with artifact analytics',
        },
      ],
    }

    renderWorkspace({ initialDetail: adversarialDetail as never })

    expect(screen.queryByLabelText('Venue')).toBeNull()
    expect(screen.getByText('We now open at nine.')).toBeTruthy()
    expect(
      screen.queryByText(/INTERNAL ONLY|secret patch|worker note|artifact analytics/i),
    ).toBeNull()
    expect(document.body.textContent).not.toMatch(/internalNotes|artifacts|analytics/)
  })

  it('uses an unobtrusive selector for multiple venues and changes only the venue query', () => {
    renderWorkspace({ venues: [venue, otherVenue] })

    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: otherVenue.id } })

    expect(mocks.replace).toHaveBeenCalledWith('/support?venue=venue_beta')
  })

  it('loads paginated requests with the exact active venue scope', async () => {
    const cursor = { updatedAt: '2026-08-09T15:00:00.000Z', id: 'request_0' }
    renderWorkspace({ initialNextCursor: cursor })

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    await waitFor(() =>
      expect(mocks.listRequests).toHaveBeenCalledWith({ venueId: venue.id, cursor }),
    )
  })

  it('does not claim a create succeeded while pending or after failure, and preserves the draft', async () => {
    const pending = deferred<never>()
    mocks.createRequest.mockReturnValueOnce(pending.promise)
    renderWorkspace({ initialRequests: [], initialDetail: null })

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'New visitor hours' } })
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Please show our summer schedule.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sending…' }))

    expect(mocks.createRequest).toHaveBeenCalledOnce()
    expect(mocks.createRequest).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      venueId: venue.id,
      category: 'GENERAL',
      subject: 'New visitor hours',
      body: 'Please show our summer schedule.',
      attachments: [],
    })
    expect(screen.queryByText(/message was sent/i)).toBeNull()

    await act(async () => pending.reject(new Error('Connection lost.')))

    expect((await screen.findByRole('alert')).textContent).toContain('draft is still here')
    expect(screen.queryByText(/message was sent/i)).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe('New visitor hours')
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe(
      'Please show our summer schedule.',
    )
  })

  it('sends replies with the displayed version and handles CAS conflicts without losing or falsely sending the draft', async () => {
    mocks.addMessage.mockRejectedValueOnce(new Error('Support request changed; refresh it'))
    renderWorkspace()

    fireEvent.change(screen.getByLabelText('Reply'), {
      target: { value: 'The revised wording looks right.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))

    await waitFor(() =>
      expect(mocks.addMessage).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        venueId: venue.id,
        requestId: request.id,
        expectedVersion: 4,
        body: 'The revised wording looks right.',
        attachments: [],
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(/not sent.*changed/i)
    expect(screen.queryByText('Your reply was sent.')).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply').value).toBe(
      'The revised wording looks right.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() =>
      expect(mocks.getRequest).toHaveBeenCalledWith({
        venueId: venue.id,
        requestId: request.id,
      }),
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply').value).toBe(
      'The revised wording looks right.',
    )
  })

  it('shows success and clears a reply only after the write resolves', async () => {
    const pending = deferred<{
      requestVersion: number
      message: typeof clientMessage
    }>()
    mocks.addMessage.mockReturnValueOnce(pending.promise)
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Thank you.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))

    expect(screen.queryByText('Your reply was sent.')).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply').value).toBe('Thank you.')

    await act(async () =>
      pending.resolve({
        requestVersion: 5,
        message: { ...clientMessage, id: 'message_2', body: 'Thank you.' },
      }),
    )

    expect(
      await screen.findByText(
        'Your message and selected files were submitted for review. Nothing was published.',
      ),
    ).toBeTruthy()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply').value).toBe('')
  })

  it('sends only exact server-provided source references for create and retains text and selection on failure', async () => {
    mocks.createRequest.mockRejectedValueOnce(new Error('Connection lost.'))
    renderWorkspace({
      initialRequests: [],
      initialDetail: null,
      initialEligibleAttachments: eligible,
    })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Review hours' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Please review this.' } })
    fireEvent.change(screen.getByLabelText('Choose one of your recent files'), {
      target: { value: 'upload_alpha' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledOnce())
    expect(mocks.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ intakeUploadId: 'upload_alpha' }] }),
    )
    expect(await screen.findByText(/draft is still here/i)).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe('Review hours')
    expect(screen.getByRole('button', { name: 'Remove visitor-hours.pdf' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/upload_beta|intakeRunId|sourceId/)
    expect(screen.queryByRole('link', { name: /visitor-hours/i })).toBeNull()
  })

  it('sends reply references, fences same-tick duplicates, and rotates identity only after edits', async () => {
    const pending = deferred<never>()
    mocks.addMessage
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('Again'))
      .mockRejectedValueOnce(new Error('Again'))
    renderWorkspace({ initialEligibleAttachments: eligible })
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'See the file.' } })
    fireEvent.change(screen.getByLabelText('Choose one of your recent files'), {
      target: { value: 'upload_alpha' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    fireEvent.submit(screen.getByLabelText('Reply').closest('form')!)
    expect(mocks.addMessage).toHaveBeenCalledOnce()
    const first = mocks.addMessage.mock.calls[0]![0]
    expect(first).toMatchObject({ attachments: [{ intakeUploadId: 'upload_alpha' }] })
    await act(async () => pending.reject(new Error('Unknown outcome.')))
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(mocks.addMessage).toHaveBeenCalledTimes(2))
    expect(mocks.addMessage.mock.calls[1]![0].operationId).toBe(first.operationId)
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'See the revised file.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(mocks.addMessage).toHaveBeenCalledTimes(3))
    expect(mocks.addMessage.mock.calls[2]![0].operationId).not.toBe(first.operationId)
  })

  it('fences conversation and venue navigation while a reply result is unresolved', async () => {
    const pending = deferred<{
      message: typeof clientMessage
      requestVersion: number
      replayed: boolean
    }>()
    mocks.addMessage.mockReturnValueOnce(pending.promise)
    const secondRequest = {
      ...request,
      id: 'request_2',
      subject: 'Second request',
      version: 1,
    }
    renderWorkspace({ venues: [venue, otherVenue], initialRequests: [request, secondRequest] })
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Pending reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))

    const secondConversation = screen.getByText('Second request').closest('button')!
    expect((secondConversation as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>('Venue').disabled).toBe(true)
    fireEvent.click(secondConversation)
    expect(mocks.getRequest).not.toHaveBeenCalled()

    await act(async () =>
      pending.resolve({
        message: { ...clientMessage, id: 'message_reply' },
        requestVersion: 5,
        replayed: false,
      }),
    )
    await waitFor(() => expect((secondConversation as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByText('Second request').closest('button')?.getAttribute('aria-current')).toBe(
      'false',
    )
  })

  it('purges hidden reply state and identity when a same-request refresh becomes terminal', async () => {
    mocks.addMessage.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
    mocks.getRequest
      .mockResolvedValueOnce({ ...detail, status: 'COMPLETED', version: 5 })
      .mockResolvedValueOnce({ ...detail, status: 'OPEN', version: 5 })
    mocks.addMessage.mockRejectedValueOnce(new Error('Unknown outcome'))
    renderWorkspace({ initialEligibleAttachments: eligible })
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Old hidden reply' } })
    fireEvent.change(screen.getByLabelText('Choose one of your recent files'), {
      target: { value: 'upload_alpha' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy())
    const oldOperationId = mocks.addMessage.mock.calls[0]![0].operationId
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByLabelText('Reply')).toBeNull())
    fireEvent.click(screen.getAllByText(request.subject)[0]!.closest('button')!)
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>('Reply').value).toBe(''))
    expect(screen.queryByRole('button', { name: 'Remove visitor-hours.pdf' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Fresh reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(mocks.addMessage).toHaveBeenCalledTimes(2))
    expect(mocks.addMessage.mock.calls[1]![0].operationId).not.toBe(oldOperationId)
  })

  it('paginates only through the exact active-venue eligible-file procedure', async () => {
    mocks.listEligibleAttachments.mockResolvedValue({
      items: [
        {
          intakeUploadId: 'upload_second',
          fileName: 'map.png',
          mimeType: 'image/png',
          byteSize: 4096,
          createdAt: '2026-08-09T13:00:00.000Z',
        },
      ],
      nextCursor: null,
    })
    renderWorkspace({
      initialRequests: [],
      initialDetail: null,
      initialEligibleAttachments: eligible,
      initialEligibleAttachmentsNextCursor: {
        createdAt: '2026-08-10T13:00:00.000Z',
        id: 'upload_alpha',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show more recent files' }))
    await waitFor(() =>
      expect(mocks.listEligibleAttachments).toHaveBeenCalledWith({
        venueId: venue.id,
        limit: 20,
        cursor: { createdAt: '2026-08-10T13:00:00.000Z', id: 'upload_alpha' },
      }),
    )
    expect(await screen.findByRole('option', { name: /map\.png/i })).toBeTruthy()
  })
})
