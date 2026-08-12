/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  link: vi.fn(),
  transition: vi.fn(),
  triage: vi.fn(),
  requestInformation: vi.fn(),
  completeRequest: vi.fn(),
  query: vi.fn(),
  listEligibleAttachments: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      addSupportMessage: { mutate: mocks.mutate },
      getSupportRequest: { query: mocks.query },
      listEligibleSupportAttachments: { query: mocks.listEligibleAttachments },
      linkSupportDraftPackage: { mutate: mocks.link },
      transitionSupportRequestStatus: { mutate: mocks.transition },
      triageSupportRequest: { mutate: mocks.triage },
      requestSupportInformation: { mutate: mocks.requestInformation },
      completeSupportRequest: { mutate: mocks.completeRequest },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

import { SupportMessageComposer } from './SupportMessageComposer'
import { SupportManualLoopActions } from './SupportManualLoopActions'
import { SupportOperationsView } from './SupportOperationsView'
import { SupportPackageHandoffForm } from './SupportPackageHandoffForm'
import { SupportStatusTransitionForm } from './SupportStatusTransitionForm'
import { SupportTriageForm } from './SupportTriageForm'
import { SupportVersionBoundActions } from './SupportVersionBoundActions'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('support operations UI', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('visually and textually distinguishes client-visible messages from internal notes', () => {
    const request = {
      id: 'req_1',
      category: 'CONTENT_CORRECTION' as const,
      missingInformation: [],
      status: 'OPEN' as const,
      subject: 'Update hours',
      version: 3,
      createdByKind: 'CLIENT',
      updatedByKind: 'OPERATOR',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    render(
      <SupportOperationsView
        tenantId="tenant_1"
        venueId="venue_1"
        requests={{ items: [request], nextCursor: null }}
        selected={request}
        messages={{
          items: [
            {
              id: 'm1',
              authorKind: 'CLIENT',
              visibility: 'CLIENT_VISIBLE',
              body: 'Client text',
              createdAt: new Date(),
              attachments: [],
            },
            {
              id: 'm2',
              authorKind: 'OPERATOR',
              visibility: 'INTERNAL_ONLY',
              body: 'Private note',
              createdAt: new Date(),
              attachments: [],
            },
          ],
          nextCursor: null,
        }}
        audit={{ items: [], nextCursor: null }}
      />,
    )
    expect(screen.getByText('CLIENT VISIBLE')).toBeTruthy()
    expect(screen.getByText('INTERNAL ONLY')).toBeTruthy()
    expect(screen.getByText('Client text')).toBeTruthy()
    expect(screen.getByText('Private note')).toBeTruthy()
    expect(screen.queryByText(/artifacts/i)).toBeNull()
  })

  it('does not render message or attachment controls for a terminal request', () => {
    const request = {
      id: 'req_closed',
      category: 'GENERAL' as const,
      missingInformation: [],
      status: 'COMPLETED' as const,
      subject: 'Finished request',
      version: 7,
      createdByKind: 'CLIENT',
      updatedByKind: 'OPERATOR',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    render(
      <SupportOperationsView
        tenantId="tenant_1"
        venueId="venue_1"
        requests={{ items: [request], nextCursor: null }}
        selected={request}
        messages={{ items: [], nextCursor: null }}
        audit={{ items: [], nextCursor: null }}
        eligibleAttachments={[
          {
            intakeUploadId: 'upload_1',
            fileName: 'hours.pdf',
            mimeType: 'application/pdf',
            byteSize: 2048,
            createdAt: new Date(),
          },
        ]}
      />,
    )
    expect(screen.getByText(/request is closed/i)).toBeTruthy()
    expect(screen.queryByLabelText('Message')).toBeNull()
    expect(screen.queryByLabelText('Choose a recent venue file')).toBeNull()
  })

  it('does not carry body, visibility, or selected files into another request', () => {
    const attachment = {
      intakeUploadId: 'upload_1',
      fileName: 'hours.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      createdAt: new Date(),
    }
    const { rerender } = render(
      <SupportMessageComposer
        key="req_1:composer"
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
        initialEligibleAttachments={[attachment]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Private draft' } })
    fireEvent.click(screen.getByLabelText(/Client visible/))
    fireEvent.change(screen.getByLabelText('Choose a recent venue file'), {
      target: { value: 'upload_1' },
    })

    rerender(
      <SupportMessageComposer
        key="req_2:composer"
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_2"
        expectedVersion={1}
        initialEligibleAttachments={[attachment]}
      />,
    )

    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>(/Internal only/).checked).toBe(true)
    expect(screen.queryByRole('button', { name: 'Remove hours.pdf' })).toBeNull()
  })

  it('submits bounded structured triage without status, message, artifact, or package fields', async () => {
    mocks.triage.mockResolvedValue({ version: 5 })
    render(
      <SupportTriageForm
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
        initialCategory="GENERAL"
        initialMissingInformation={['Opening date']}
        closed={false}
      />,
    )
    fireEvent.change(screen.getByLabelText('Request category'), {
      target: { value: 'CONTENT_CORRECTION' },
    })
    fireEvent.change(screen.getByLabelText('Missing information'), {
      target: { value: ' Current admission price \nEffective date' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record triage' }))
    await waitFor(() => expect(mocks.triage).toHaveBeenCalledOnce())
    expect(mocks.triage).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'req_1',
      expectedVersion: 4,
      category: 'CONTENT_CORRECTION',
      missingInformation: ['Current admission price', 'Effective date'],
    })
    const sent = mocks.triage.mock.calls[0]![0]
    expect(sent).not.toHaveProperty('status')
    expect(sent).not.toHaveProperty('body')
    expect(sent).not.toHaveProperty('artifacts')
    expect(sent).not.toHaveProperty('venuePackageId')
    expect(screen.getByRole('status').textContent).toContain('No status changed')
  })

  it('retains triage fields and rejects duplicate missing-information lines locally', async () => {
    render(
      <SupportTriageForm
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
        initialCategory="GENERAL"
        initialMissingInformation={[]}
        closed={false}
      />,
    )
    const input = screen.getByLabelText('Missing information') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Same item\n Same item ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record triage' }))
    expect(mocks.triage).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('must be unique')
    expect(input.value).toBe('Same item\n Same item ')
  })

  it('retains triage selections without refreshing after a version conflict', async () => {
    mocks.triage.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
    render(
      <SupportTriageForm
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
        initialCategory="GENERAL"
        initialMissingInformation={[]}
        closed={false}
      />,
    )
    const category = screen.getByLabelText('Request category') as HTMLSelectElement
    const missing = screen.getByLabelText('Missing information') as HTMLTextAreaElement
    fireEvent.change(category, { target: { value: 'ACCESSIBILITY' } })
    fireEvent.change(missing, { target: { value: 'Ramp dimensions\nAccessible entrance' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record triage' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('request changed'))
    expect(screen.getByRole('alert').textContent).toContain('refresh the page before retrying')
    expect(category.value).toBe('ACCESSIBILITY')
    expect(missing.value).toBe('Ramp dimensions\nAccessible entrance')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('serializes writes and sends the explicit visibility with CAS version', async () => {
    let resolve!: () => void
    mocks.mutate.mockReturnValue(
      new Promise<{ requestVersion: number }>((done) => {
        resolve = () => done({ requestVersion: 5 })
      }),
    )
    render(
      <SupportMessageComposer
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
      />,
    )
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Draft response' } })
    fireEvent.click(screen.getByLabelText(/Client visible/))
    const submit = screen.getByRole('button', { name: 'Add client-visible message' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(mocks.mutate).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'req_1',
      expectedVersion: 4,
      visibility: 'CLIENT_VISIBLE',
      body: 'Draft response',
      attachments: [],
    })
    resolve()
    await waitFor(() => expect(screen.getByText('Client-visible message added.')).toBeTruthy())
  })

  it('sends only selected eligible admin file references and retains them after an ambiguous error', async () => {
    mocks.mutate
      .mockRejectedValueOnce(new Error('Unknown outcome'))
      .mockRejectedValueOnce(new Error('Unknown outcome'))
    render(
      <SupportMessageComposer
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
        initialEligibleAttachments={[
          {
            intakeUploadId: 'upload_1',
            fileName: 'hours.pdf',
            mimeType: 'application/pdf',
            byteSize: 2048,
            createdAt: '2026-08-10T13:00:00.000Z',
          },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Review this file' } })
    fireEvent.change(screen.getByLabelText('Choose a recent venue file'), {
      target: { value: 'upload_1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add internal note' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ intakeUploadId: 'upload_1' }] }),
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('Review this file')
    expect(screen.getByRole('button', { name: 'Remove hours.pdf' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /hours\.pdf/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh request' })).toBeNull()
    const firstOperationId = mocks.mutate.mock.calls[0]![0].operationId
    fireEvent.click(screen.getByRole('button', { name: 'Add internal note' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.mutate.mock.calls[1]![0].operationId).toBe(firstOperationId)
  })

  it('retains the draft and blocks retry after a version conflict', async () => {
    mocks.mutate.mockRejectedValue({ data: { code: 'CONFLICT' } })
    render(
      <SupportMessageComposer
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={2}
      />,
    )
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Keep this note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add internal note' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('draft is retained'),
    )
    expect(input.value).toBe('Keep this note')
    expect(screen.getByRole('button', { name: 'Refresh request' })).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Add internal note' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    mocks.query.mockResolvedValue({ version: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh request' }))
    await waitFor(() =>
      expect(screen.getByText('Request version refreshed. Your draft is retained.')).toBeTruthy(),
    )
    expect(input.value).toBe('Keep this note')
    expect(
      (screen.getByRole('button', { name: 'Add internal note' }) as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(screen.getByText('Request version 3')).toBeTruthy()
  })

  it('links only a selected existing draft with exact scope and CAS, once', async () => {
    let resolve!: () => void
    mocks.link.mockReturnValue(
      new Promise((done) => {
        resolve = () => done({ requestVersion: 5 })
      }),
    )
    render(
      <SupportPackageHandoffForm
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
        closed={false}
        packages={[
          {
            id: 'pkg_1',
            schemaVersion: 2,
            payloadHash: 'abcdef1234567890',
            createdBy: 'admin',
            createdAt: new Date(),
          },
        ]}
      />,
    )
    const submit = screen.getByRole('button', { name: 'Link selected draft' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(mocks.link).toHaveBeenCalledTimes(1)
    expect(mocks.link).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'req_1',
      venuePackageId: 'pkg_1',
      expectedVersion: 4,
    })
    expect(screen.queryByRole('button', { name: /approve|apply|publish|create/i })).toBeNull()
    resolve()
    await waitFor(() => expect(screen.getByText(/Draft package linked/)).toBeTruthy())
  })

  it('requires deliberate confirmation and submits only an allowed transition with CAS', async () => {
    mocks.transition.mockResolvedValue({ status: 'PATCH_DRAFTED', version: 4 })
    render(
      <SupportStatusTransitionForm
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        currentStatus="IN_REVIEW"
        expectedVersion={3}
      />,
    )
    const submit = screen.getByRole('button', { name: 'Record status change' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.queryByRole('option', { name: 'Waiting for client' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Completed' })).toBeNull()
    fireEvent.click(screen.getByLabelText(/I confirm/))
    fireEvent.click(submit)
    await waitFor(() =>
      expect(mocks.transition).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'req_1',
        expectedVersion: 3,
        toStatus: 'PATCH_DRAFTED',
      }),
    )
    expect(screen.getByText(/No package action was run/)).toBeTruthy()
  })

  it('atomically requests exact client information with CAS, replay identity, and same-tick fencing', async () => {
    let resolve!: (value: unknown) => void
    mocks.requestInformation.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    render(
      <SupportManualLoopActions
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
        currentStatus="OPEN"
        missingInformation={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Message to client'), {
      target: { value: 'Please send these details.' },
    })
    fireEvent.change(screen.getByLabelText('Details needed'), {
      target: { value: ' Effective date \nCurrent admission price' },
    })
    const submit = screen.getByRole('button', { name: 'Send questions' })
    fireEvent.click(submit)
    fireEvent.submit(submit.closest('form')!)

    expect(mocks.requestInformation).toHaveBeenCalledOnce()
    expect(mocks.requestInformation).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'req_1',
      expectedVersion: 4,
      body: 'Please send these details.',
      missingInformation: ['Effective date', 'Current admission price'],
    })
    const sent = mocks.requestInformation.mock.calls[0]![0]
    expect(sent).not.toHaveProperty('attachments')
    expect(sent).not.toHaveProperty('packageId')
    expect(screen.queryByText(/now waiting for the client/i)).toBeNull()

    await act(async () => resolve({ status: 'WAITING_FOR_CLIENT', replayed: false }))
    expect(await screen.findByText(/now waiting for the client/i)).toBeTruthy()
    expect(screen.getByText(/No package work was run/i)).toBeTruthy()
  })

  it('requires confirmation for manual completion and does not claim execution', async () => {
    mocks.completeRequest.mockResolvedValueOnce({ status: 'COMPLETED', replayed: false })
    const { container } = render(
      <SupportManualLoopActions
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={6}
        currentStatus="IN_REVIEW"
        missingInformation={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Completion message to client'), {
      target: { value: 'We have answered your question.' },
    })
    const submit = screen.getByRole('button', {
      name: 'Complete support request',
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/I confirm this conversation is complete/))
    fireEvent.click(submit)

    await waitFor(() =>
      expect(mocks.completeRequest).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'req_1',
        expectedVersion: 6,
        body: 'We have answered your question.',
      }),
    )
    expect(screen.getByRole('status').textContent).toMatch(
      /No package was approved, applied, or published/i,
    )
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })

  it('drops late manual-action outcomes after a render-synchronous scope change', async () => {
    let resolve!: (value: unknown) => void
    mocks.requestInformation.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    const rendered = render(
      <SupportManualLoopActions
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={2}
        currentStatus="OPEN"
        missingInformation={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Message to client'), {
      target: { value: 'Old scope body' },
    })
    fireEvent.change(screen.getByLabelText('Details needed'), {
      target: { value: 'Old scope detail' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send questions' }))

    rendered.rerender(
      <SupportManualLoopActions
        tenantId="tenant_1"
        venueId="venue_2"
        requestId="req_2"
        expectedVersion={1}
        currentStatus="OPEN"
        missingInformation={[]}
      />,
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message to client').value).toBe('')
    await act(async () => resolve({ status: 'WAITING_FOR_CLIENT', replayed: false }))
    expect(screen.queryByText(/now waiting for the client/i)).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('renders the exact manual-action eligibility matrix and truthful reasons', () => {
    const rendered = render(
      <SupportManualLoopActions
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={2}
        currentStatus="WAITING_FOR_CLIENT"
        missingInformation={['Effective date']}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Send questions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Complete support request' })).toBeNull()
    expect(
      screen.getAllByText(/only while this conversation is received or in review/i),
    ).toHaveLength(2)

    rendered.rerender(
      <SupportManualLoopActions
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={3}
        currentStatus="IN_REVIEW"
        missingInformation={['Effective date']}
      />,
    )
    expect(screen.getByRole('button', { name: 'Send questions' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Complete support request' })).toBeNull()
    expect(screen.getByText(/Resolve the recorded information checklist/i)).toBeTruthy()
  })

  it('locks every sibling action synchronously after confirmation until a new version renders', async () => {
    let resolve!: (value: unknown) => void
    mocks.completeRequest.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    const sibling = vi.fn()
    const rendered = render(
      <SupportVersionBoundActions
        key="req_1:4"
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={4}
        currentStatus="OPEN"
        missingInformation={[]}
      >
        <button type="button" onClick={sibling}>
          Sibling version-bound action
        </button>
      </SupportVersionBoundActions>,
    )
    fireEvent.change(screen.getByLabelText('Completion message to client'), {
      target: { value: 'This is resolved.' },
    })
    fireEvent.click(screen.getByLabelText(/I confirm this conversation is complete/))
    fireEvent.click(screen.getByRole('button', { name: 'Complete support request' }))
    await act(async () => resolve({ status: 'COMPLETED', replayed: false }))

    expect(screen.queryByRole('button', { name: 'Sibling version-bound action' })).toBeNull()
    expect(sibling).not.toHaveBeenCalled()
    expect(screen.getByText(/latest version loads/i)).toBeTruthy()

    rendered.rerender(
      <SupportVersionBoundActions
        key="req_1:5"
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        expectedVersion={5}
        currentStatus="IN_REVIEW"
        missingInformation={[]}
      >
        <button type="button" onClick={sibling}>
          Sibling version-bound action
        </button>
      </SupportVersionBoundActions>,
    )
    expect(screen.getByRole('button', { name: 'Sibling version-bound action' })).toBeTruthy()
  })

  it('offers no transition control for terminal client-visible status', () => {
    render(
      <SupportStatusTransitionForm
        tenantId="tenant_1"
        venueId="venue_1"
        requestId="req_1"
        currentStatus="COMPLETED"
        expectedVersion={8}
      />,
    )
    expect(screen.getByText('This request is in a terminal status.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Record status change' })).toBeNull()
  })
})
