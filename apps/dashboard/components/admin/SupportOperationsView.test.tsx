/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  link: vi.fn(),
  transition: vi.fn(),
  triage: vi.fn(),
  query: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      addSupportMessage: { mutate: mocks.mutate },
      getSupportRequest: { query: mocks.query },
      linkSupportDraftPackage: { mutate: mocks.link },
      transitionSupportRequestStatus: { mutate: mocks.transition },
      triageSupportRequest: { mutate: mocks.triage },
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
import { SupportOperationsView } from './SupportOperationsView'
import { SupportPackageHandoffForm } from './SupportPackageHandoffForm'
import { SupportStatusTransitionForm } from './SupportStatusTransitionForm'
import { SupportTriageForm } from './SupportTriageForm'
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
    fireEvent.click(screen.getByLabelText(/I confirm/))
    fireEvent.click(submit)
    await waitFor(() =>
      expect(mocks.transition).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        requestId: 'req_1',
        expectedVersion: 3,
        toStatus: 'WAITING_FOR_CLIENT',
      }),
    )
    expect(screen.getByText(/No package action was run/)).toBeTruthy()
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
