/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  listRequests: vi.fn(),
  getRequest: vi.fn(),
  createRequest: vi.fn(),
  addMessage: vi.fn(),
  respondToInformation: vi.fn(),
  listParticipantCandidates: vi.fn(),
  grantParticipant: vi.fn(),
  revokeParticipant: vi.fn(),
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
      respondToInformation: { mutate: mocks.respondToInformation },
      listParticipantCandidates: { query: mocks.listParticipantCandidates },
      grantParticipant: { mutate: mocks.grantParticipant },
      revokeParticipant: { mutate: mocks.revokeParticipant },
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
  clientVersion: 4,
  clientActivityAt: '2026-08-10T15:00:00.000Z',
  requesterIsCurrentUser: true,
  participantIsCurrentUser: false,
  canReply: true,
  statusChangedAt: '2026-08-10T14:00:00.000Z',
  createdAt: '2026-08-10T14:00:00.000Z',
}
const clientMessage = {
  id: 'message_1',
  authorKind: 'CLIENT',
  authorIsCurrentUser: true,
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
  it('explains the operator-preview boundary and links to the full Support workspace', () => {
    renderWorkspace({
      operatorSupportHref: '/admin/clients/tenant-1/venues/venue-1/support-operations',
    })
    expect(
      screen.getByText(/only conversations and eligible files belonging to your admin identity/),
    ).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'Open this venue’s Support workspace' })
        .getAttribute('href'),
    ).toBe('/admin/clients/tenant-1/venues/venue-1/support-operations')
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listRequests.mockResolvedValue({ items: [], nextCursor: null })
    mocks.getRequest.mockResolvedValue(detail)
    mocks.listParticipantCandidates.mockResolvedValue({ candidates: [], nextCursor: null })
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

  it('shows bounded client questions with reply and upload actions, then hides them when resolved', async () => {
    const requestedDetail = {
      ...detail,
      missingInformation: [
        'Current admission price',
        'Date the price takes effect',
        'Child admission price',
        'Senior admission price',
        'Member admission price',
        'Group admission price',
        'Holiday admission price',
        'School admission price',
      ],
      status: 'WAITING_FOR_CLIENT',
    }
    const rendered = renderWorkspace({
      initialRequests: [{ ...request, ...requestedDetail }],
      initialDetail: requestedDetail,
    })

    expect(
      screen.getByRole('heading', { name: 'A few details will help us continue' }),
    ).toBeTruthy()
    expect(screen.getByText('Current admission price')).toBeTruthy()
    expect(screen.getByText('3 more details in this request')).toBeTruthy()
    expect(screen.queryByText('Group admission price')).toBeNull()
    expect(screen.getByRole('link', { name: 'Reply with details' }).getAttribute('href')).toBe(
      '#support-reply',
    )
    expect(screen.getByRole('link', { name: 'Share a file or website' }).getAttribute('href')).toBe(
      '/venues/venue_alpha/intake',
    )
    fireEvent.click(screen.getByRole('button', { name: 'I don’t know' }))
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply').value).toBe("I don't know.")
    expect(document.body.textContent).not.toMatch(/package|handoff|hash|quarantin|internal note/iu)

    rendered.rerender(
      <SupportWorkspace
        venues={[venue]}
        activeVenue={venue}
        initialRequests={[request]}
        initialNextCursor={null}
        initialDetail={detail}
        initialEligibleAttachments={[]}
        initialEligibleAttachmentsNextCursor={null}
      />,
    )
    await waitFor(() => expect(screen.queryByText('Current admission price')).toBeNull())
    expect(screen.queryByRole('link', { name: 'Reply with details' })).toBeNull()
  })

  it('loads paginated requests with the exact active venue scope', async () => {
    const cursor = { clientActivityAt: '2026-08-09T15:00:00.000Z', id: 'request_0' }
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
    expect(screen.queryByText(/submitted for review/i)).toBeNull()

    await act(async () => pending.reject(new Error('Connection lost.')))

    expect((await screen.findByRole('alert')).textContent).toContain('draft is still here')
    expect(screen.queryByText(/submitted for review/i)).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe('New visitor hours')
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe(
      'Please show our summer schedule.',
    )
  })

  it('starts a visitor-insight request with safe service-led defaults', () => {
    renderWorkspace({
      initialCreateDraft: {
        category: 'CONTENT_CORRECTION',
        subject: 'Visitor experience review',
      },
    })

    expect(screen.getByLabelText<HTMLSelectElement>('What is this about?').value).toBe(
      'CONTENT_CORRECTION',
    )
    expect(screen.getByLabelText<HTMLInputElement>('Subject').value).toBe(
      'Visitor experience review',
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('')
  })

  it('sends replies with the displayed version and handles CAS conflicts without losing or falsely sending the draft', async () => {
    mocks.addMessage.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
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
        expectedClientVersion: 4,
        body: 'The revised wording looks right.',
        attachments: [],
      }),
    )
    expect((await screen.findByRole('alert')).textContent).toMatch(/not sent.*changed/i)
    expect(screen.queryByText('Your reply was sent.')).toBeNull()
    expect((await screen.findByLabelText<HTMLTextAreaElement>('Reply')).value).toBe(
      'The revised wording looks right.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() =>
      expect(mocks.getRequest).toHaveBeenCalledWith({
        venueId: venue.id,
        requestId: request.id,
      }),
    )
    expect((await screen.findByLabelText<HTMLTextAreaElement>('Reply')).value).toBe(
      'The revised wording looks right.',
    )
  })

  it('shows success and clears a reply only after the write resolves', async () => {
    const pending = deferred<{
      clientVersion: number
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
        clientVersion: 5,
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

  it('answers a missing-information request through the dedicated action and resolves its checklist', async () => {
    const requested = {
      ...detail,
      status: 'WAITING_FOR_CLIENT',
      missingInformation: ['Effective date'],
    }
    const pending = deferred<{
      message: typeof clientMessage
      status: string
      missingInformation: string[]
      requestVersion: number
      clientVersion: number
      replayed: boolean
    }>()
    mocks.respondToInformation.mockReturnValueOnce(pending.promise)
    const response = {
      message: { ...clientMessage, id: 'response-1', body: 'Effective September 1.' },
      status: 'IN_REVIEW',
      missingInformation: [],
      requestVersion: 8,
      clientVersion: 5,
      replayed: false,
    }
    renderWorkspace({ initialRequests: [requested], initialDetail: requested })
    fireEvent.change(screen.getByLabelText('Reply'), {
      target: { value: 'Effective September 1.' },
    })
    const submit = screen.getByRole('button', { name: 'Send reply' })
    fireEvent.click(submit)
    fireEvent.submit(submit.closest('form')!)

    await waitFor(() =>
      expect(mocks.respondToInformation).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        venueId: venue.id,
        requestId: request.id,
        expectedClientVersion: 4,
        body: 'Effective September 1.',
        attachments: [],
      }),
    )
    expect(mocks.respondToInformation).toHaveBeenCalledOnce()
    expect(mocks.addMessage).not.toHaveBeenCalled()
    await act(async () => pending.resolve(response))
    expect(await screen.findByText('Effective September 1.')).toBeTruthy()
    expect(screen.queryByText('Effective date')).toBeNull()
    expect(screen.getByText('In review')).toBeTruthy()
  })

  it('never renders raw support failures and retains the exact retry identity', async () => {
    const sentinel = 'signed-object-path=/private/claim-secret provider=warehouse'
    mocks.addMessage
      .mockRejectedValueOnce(new Error(sentinel))
      .mockRejectedValueOnce(new Error(sentinel))
    renderWorkspace()
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Keep this reply.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(mocks.addMessage).toHaveBeenCalledOnce())
    const operationId = mocks.addMessage.mock.calls[0]![0].operationId
    expect(screen.getByRole('alert').textContent).toContain('could not confirm')
    expect(document.body.textContent).not.toContain(sentinel)
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reply').value).toBe('Keep this reply.')

    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(mocks.addMessage).toHaveBeenCalledTimes(2))
    expect(mocks.addMessage.mock.calls[1]![0].operationId).toBe(operationId)
  })

  it('ignores a late create result after a render-synchronous venue scope change', async () => {
    const pending = deferred<{
      request: typeof request
      message: typeof clientMessage
    }>()
    mocks.createRequest.mockReturnValueOnce(pending.promise)
    const rendered = renderWorkspace({
      venues: [venue, otherVenue],
      initialRequests: [],
      initialDetail: null,
    })
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Old venue request' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Old venue message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))

    rendered.rerender(
      <SupportWorkspace
        venues={[venue, otherVenue]}
        activeVenue={otherVenue}
        initialRequests={[]}
        initialNextCursor={null}
        initialDetail={null}
        initialEligibleAttachments={[]}
        initialEligibleAttachmentsNextCursor={null}
      />,
    )
    await act(async () =>
      pending.resolve({
        request: { ...request, subject: 'Old venue request' },
        message: { ...clientMessage, body: 'Old venue message' },
      }),
    )

    expect(screen.getByText(otherVenue.name)).toBeTruthy()
    expect(screen.queryByText('Old venue request')).toBeNull()
    expect(screen.queryByText(/submitted for review/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Send request' })).toBeTruthy()
  })

  it('ignores a late reply result and releases the write lock after venue scope changes', async () => {
    const pending = deferred<{
      clientVersion: number
      message: typeof clientMessage
    }>()
    mocks.addMessage.mockReturnValueOnce(pending.promise)
    const rendered = renderWorkspace({ venues: [venue, otherVenue] })
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Old venue reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))

    const otherRequest = { ...request, id: 'request_beta', venueId: otherVenue.id }
    const otherDetail = {
      ...otherRequest,
      messages: [{ ...clientMessage, id: 'message_beta', body: 'Current venue message.' }],
      nextMessageCursor: null,
    }
    rendered.rerender(
      <SupportWorkspace
        venues={[venue, otherVenue]}
        activeVenue={otherVenue}
        initialRequests={[otherRequest]}
        initialNextCursor={null}
        initialDetail={otherDetail}
        initialEligibleAttachments={[]}
        initialEligibleAttachmentsNextCursor={null}
      />,
    )
    await act(async () =>
      pending.resolve({
        clientVersion: 5,
        message: { ...clientMessage, id: 'late_message', body: 'Old venue reply' },
      }),
    )

    expect(screen.getByText('Current venue message.')).toBeTruthy()
    expect(screen.queryByText('Old venue reply')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeTruthy()
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
      clientVersion: number
      replayed: boolean
    }>()
    mocks.addMessage.mockReturnValueOnce(pending.promise)
    const secondRequest = {
      ...request,
      id: 'request_2',
      subject: 'Second request',
      clientVersion: 1,
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
        clientVersion: 5,
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
      .mockResolvedValueOnce({ ...detail, status: 'COMPLETED', clientVersion: 5, canReply: false })
      .mockResolvedValueOnce({ ...detail, status: 'OPEN', clientVersion: 5 })
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

  it('uses safe server identity flags for requester and message labels and suppresses replies without authority', () => {
    const teammateRequest = {
      ...request,
      requesterIsCurrentUser: false,
      participantIsCurrentUser: true,
      canReply: false,
    }
    renderWorkspace({
      initialRequests: [teammateRequest],
      initialDetail: {
        ...detail,
        ...teammateRequest,
        messages: [{ ...clientMessage, authorIsCurrentUser: false, body: 'A teammate update.' }],
      },
    })

    expect(screen.getAllByText(/Your team/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^You ·/)).toBeNull()
    expect(
      screen.getByText('You no longer have access to reply to this conversation.'),
    ).toBeTruthy()
    expect(screen.queryByLabelText('Reply')).toBeNull()
  })

  it('ignores a late detail response after a newer conversation has opened', async () => {
    const first = deferred<typeof detail>()
    const secondRequest = {
      ...request,
      id: 'request_2',
      subject: 'Second request',
      clientVersion: 1,
    }
    const secondDetail = {
      ...detail,
      ...secondRequest,
      messages: [{ ...clientMessage, id: 'message_2', body: 'Second conversation.' }],
    }
    mocks.getRequest.mockImplementation(({ requestId }: { requestId: string }) =>
      requestId === request.id ? first.promise : Promise.resolve(secondDetail),
    )
    renderWorkspace({ initialRequests: [request, secondRequest] })

    fireEvent.click(screen.getAllByText(request.subject)[0]!.closest('button')!)
    fireEvent.click(screen.getByText(secondRequest.subject).closest('button')!)
    expect(await screen.findByText('Second conversation.')).toBeTruthy()

    await act(async () => first.resolve(detail))
    expect(screen.getByText('Second conversation.')).toBeTruthy()
    expect(screen.queryByText(clientMessage.body)).toBeNull()
  })

  it('never merges a late message page from one conversation into another', async () => {
    const page = deferred<typeof detail>()
    const cursor = { createdAt: '2026-08-10T15:00:00.000Z', id: 'message_1' }
    const firstDetail = { ...detail, nextMessageCursor: cursor }
    const secondRequest = {
      ...request,
      id: 'request_2',
      subject: 'Second request',
      clientVersion: 1,
    }
    const secondDetail = {
      ...detail,
      ...secondRequest,
      messages: [{ ...clientMessage, id: 'message_2', body: 'Second conversation.' }],
      nextMessageCursor: null,
    }
    mocks.getRequest.mockImplementation(
      ({ requestId, messageCursor }: { requestId: string; messageCursor?: unknown }) =>
        messageCursor
          ? page.promise
          : Promise.resolve(requestId === request.id ? firstDetail : secondDetail),
    )
    renderWorkspace({ initialRequests: [request, secondRequest], initialDetail: firstDetail })

    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }))
    fireEvent.click(screen.getByText(secondRequest.subject).closest('button')!)
    expect(await screen.findByText('Second conversation.')).toBeTruthy()
    await act(async () =>
      page.resolve({
        ...firstDetail,
        messages: [{ ...clientMessage, id: 'late_message', body: 'Late private page.' }],
        nextMessageCursor: null,
      }),
    )

    expect(screen.queryByText('Late private page.')).toBeNull()
    expect(screen.getByText('Second conversation.')).toBeTruthy()
  })

  it('purges the thread and scoped reply state when access is revoked during message pagination', async () => {
    const cursor = { createdAt: '2026-08-10T15:00:00.000Z', id: 'message_1' }
    mocks.getRequest.mockRejectedValueOnce({ data: { code: 'NOT_FOUND' } })
    renderWorkspace({
      initialDetail: { ...detail, nextMessageCursor: cursor },
      initialEligibleAttachments: eligible,
    })
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Private page draft.' } })
    fireEvent.change(screen.getByLabelText('Choose one of your recent files'), {
      target: { value: 'upload_alpha' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }))

    expect(await screen.findByText('This conversation is not available.')).toBeTruthy()
    expect(screen.queryByText(request.subject)).toBeNull()
    expect(screen.queryByText('Private page draft.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove visitor-hours.pdf' })).toBeNull()
    expect(screen.queryByLabelText('Reply')).toBeNull()
  })

  it('does not let older request pagination clear a newer detail loading state', async () => {
    const listPage = deferred<{ items: never[]; nextCursor: null }>()
    const nextDetail = deferred<typeof detail>()
    const cursor = { clientActivityAt: '2026-08-09T15:00:00.000Z', id: 'request_0' }
    const secondRequest = {
      ...request,
      id: 'request_2',
      subject: 'Second request',
      clientVersion: 1,
    }
    mocks.listRequests.mockReturnValueOnce(listPage.promise)
    mocks.getRequest.mockReturnValueOnce(nextDetail.promise)
    renderWorkspace({ initialRequests: [request, secondRequest], initialNextCursor: cursor })

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    fireEvent.click(screen.getByText(secondRequest.subject).closest('button')!)
    expect(screen.getByText('Opening conversation…')).toBeTruthy()

    await act(async () => listPage.resolve({ items: [], nextCursor: null }))
    expect(screen.getByText('Opening conversation…')).toBeTruthy()

    await act(async () =>
      nextDetail.resolve({
        ...detail,
        ...secondRequest,
        messages: [{ ...clientMessage, id: 'message_2', body: 'Newest detail.' }],
      }),
    )
    expect(await screen.findByText('Newest detail.')).toBeTruthy()
  })

  it('clears scoped reply state on nondisclosing access loss', async () => {
    mocks.getRequest.mockRejectedValueOnce({ data: { code: 'NOT_FOUND' } })
    renderWorkspace({ initialEligibleAttachments: eligible })
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Private draft.' } })
    fireEvent.change(screen.getByLabelText('Choose one of your recent files'), {
      target: { value: 'upload_alpha' },
    })

    fireEvent.click(screen.getAllByText(request.subject)[0]!.closest('button')!)
    expect(await screen.findByText('This conversation is not available.')).toBeTruthy()
    expect(screen.queryByLabelText('Reply')).toBeNull()
    expect(screen.queryByText('Private draft.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove visitor-hours.pdf' })).toBeNull()
    expect(screen.queryByText(request.subject)).toBeNull()
  })

  it('purges conversation drafts and server-provided files when the venue scope changes', async () => {
    const rendered = renderWorkspace({
      venues: [venue, otherVenue],
      initialEligibleAttachments: eligible,
    })
    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'Venue-only draft.' } })
    fireEvent.change(screen.getByLabelText('Choose one of your recent files'), {
      target: { value: 'upload_alpha' },
    })

    rendered.rerender(
      <SupportWorkspace
        venues={[venue, otherVenue]}
        activeVenue={otherVenue}
        initialRequests={[]}
        initialNextCursor={null}
        initialDetail={null}
        initialEligibleAttachments={[]}
        initialEligibleAttachmentsNextCursor={null}
      />,
    )

    await waitFor(() => expect(screen.queryByText(request.subject)).toBeNull())
    expect(screen.queryByText('Venue-only draft.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove visitor-hours.pdf' })).toBeNull()
    expect(screen.getByText('You have no support conversations yet.')).toBeTruthy()
  })

  it('has no automated accessibility violations for a populated participant thread', async () => {
    const { container } = renderWorkspace({ initialEligibleAttachments: eligible })
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map(({ id }) => id)).toEqual([])
  })

  it('shows participant management only to the requester and sends exact CAS actions', async () => {
    mocks.listParticipantCandidates.mockResolvedValueOnce({
      candidates: [
        { userId: 'member-2', displayLabel: 'Alex Morgan', activeOnRequest: false },
        { userId: 'member-3', displayLabel: 'Sam Lee', activeOnRequest: true },
      ],
      nextCursor: null,
    })
    mocks.grantParticipant.mockResolvedValueOnce({
      clientVersion: 5,
      requestVersion: 5,
      active: true,
    })
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Manage team access' }))
    expect(await screen.findByText('Alex Morgan')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Give access' }))
    await waitFor(() =>
      expect(mocks.grantParticipant).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        venueId: venue.id,
        requestId: request.id,
        userId: 'member-2',
        expectedClientVersion: 4,
      }),
    )
    expect(mocks.revokeParticipant).not.toHaveBeenCalled()
    expect(await screen.findByText(/refreshing before more actions/i)).toBeTruthy()

    cleanup()
    renderWorkspace({
      initialRequests: [
        { ...request, requesterIsCurrentUser: false, participantIsCurrentUser: true },
      ],
      initialDetail: { ...detail, requesterIsCurrentUser: false, participantIsCurrentUser: true },
    })
    expect(screen.queryByRole('heading', { name: 'Conversation access' })).toBeNull()
  })

  it('fences duplicate and late candidate reads after same-request authority changes', async () => {
    const pending = deferred<{
      candidates: { userId: string; displayLabel: string; activeOnRequest: boolean }[]
      nextCursor: null
    }>()
    mocks.listParticipantCandidates.mockReturnValueOnce(pending.promise)
    const rendered = renderWorkspace()
    const manage = screen.getByRole('button', { name: 'Manage team access' })
    fireEvent.click(manage)
    fireEvent.click(manage)
    expect(mocks.listParticipantCandidates).toHaveBeenCalledOnce()

    const downgraded = {
      ...detail,
      clientVersion: 5,
      requesterIsCurrentUser: false,
      participantIsCurrentUser: true,
    }
    rendered.rerender(
      <SupportWorkspace
        venues={[venue]}
        activeVenue={venue}
        initialRequests={[downgraded]}
        initialNextCursor={null}
        initialDetail={downgraded}
        initialEligibleAttachments={[]}
        initialEligibleAttachmentsNextCursor={null}
      />,
    )
    await act(async () =>
      pending.resolve({
        candidates: [
          { userId: 'private-member', displayLabel: 'Private member', activeOnRequest: false },
        ],
        nextCursor: null,
      }),
    )
    expect(screen.queryByText('Private member')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Conversation access' })).toBeNull()
  })
})
