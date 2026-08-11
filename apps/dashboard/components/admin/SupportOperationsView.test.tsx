/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), query: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      addSupportMessage: { mutate: mocks.mutate },
      getSupportRequest: { query: mocks.query },
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
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('support operations UI', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('visually and textually distinguishes client-visible messages from internal notes', () => {
    const request = {
      id: 'req_1',
      category: 'CONTENT_CHANGE',
      status: 'OPEN',
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
})
