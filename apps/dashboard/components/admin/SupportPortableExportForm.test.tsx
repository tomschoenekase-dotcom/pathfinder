/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SupportPortableExportForm } from './SupportPortableExportForm'

afterEach(cleanup)

const props = {
  tenantId: 'tenant-a',
  venues: [{ id: 'venue-a', name: 'Riverside Aquarium with an intentionally long venue label', isActive: true }],
  recipients: [
    {
      userId: 'user-a',
      fullName: 'Avery Operator with a deliberately long name for the select control',
      email: 'avery@example.test',
      role: 'OWNER' as const,
    },
  ],
  sections: ['current-venue', 'content-history', 'venue-packages', 'published-reports', 'recipient-support'] as const,
  maxExportBytes: 10 * 1024 * 1024,
}

describe('SupportPortableExportForm', () => {
  const fetchMock = vi.fn()
  const createObjectUrl = vi.fn<(blob: Blob) => string>(() => 'blob:portable-export')
  const revokeObjectUrl = vi.fn()
  const anchorClick = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    createObjectUrl.mockClear()
    revokeObjectUrl.mockClear()
    anchorClick.mockClear()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(anchorClick)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('requires an explicit recipient, venue, and requested section before preparing', () => {
    render(<SupportPortableExportForm {...props} />)
    const button = screen.getByRole('button', { name: 'Prepare JSON download' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Existing account recipient'), { target: { value: 'user-a' } })
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'venue-a' } })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Current venue/ }))
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('downloads the exact response bytes once and immediately reports the limited scope', async () => {
    const exported = '{"contentSha256":"a"}'
    fetchMock.mockResolvedValue(new Response(exported, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(new TextEncoder().encode(exported).byteLength) } }))
    render(<SupportPortableExportForm {...props} />)
    fireEvent.change(screen.getByLabelText('Existing account recipient'), { target: { value: 'user-a' } })
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'venue-a' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Current venue/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare JSON download' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/admin/clients/tenant-a/support-export')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(String(init.body))).toEqual({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      recipientUserId: 'user-a',
      sections: ['current-venue'],
    })
    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1))
    const firstObjectUrlCall = createObjectUrl.mock.calls[0]
    if (!firstObjectUrlCall) throw new Error('Expected an object URL call')
    expect(firstObjectUrlCall[0].size).toBe(new TextEncoder().encode(exported).byteLength)
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(
      screen.getByText('Prepared a scoped JSON download. It was not sent or attached to a support ticket.'),
    ).toBeTruthy()
    await waitFor(() => expect(revokeObjectUrl).toHaveBeenCalledWith('blob:portable-export'))
  })

  it('rejects a successful non-JSON response without downloading it', async () => {
    fetchMock.mockResolvedValue(new Response('<html>sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    render(<SupportPortableExportForm {...props} />)
    fireEvent.change(screen.getByLabelText('Existing account recipient'), { target: { value: 'user-a' } })
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'venue-a' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Current venue/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare JSON download' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('was not a portable JSON file'),
    )
    expect(createObjectUrl).not.toHaveBeenCalled()
  })
  it('prevents a duplicate request while an export is pending and gives a bounded error', async () => {
    let resolveResponse: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve
        }),
    )
    render(<SupportPortableExportForm {...props} />)
    fireEvent.change(screen.getByLabelText('Existing account recipient'), { target: { value: 'user-a' } })
    fireEvent.change(screen.getByLabelText('Venue'), { target: { value: 'venue-a' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Current venue/ }))
    const button = screen.getByRole('button', { name: 'Prepare JSON download' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Preparing export…' }).hasAttribute('disabled')).toBe(true)
    resolveResponse?.(new Response('too large', { status: 413 }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('larger than the safe download limit'),
    )
  })

  it('makes manager-or-owner-only sections unavailable for an active staff recipient', () => {
    const ownerRecipient = props.recipients.at(0)
    if (!ownerRecipient) throw new Error('Expected a synthetic recipient')
    render(
      <SupportPortableExportForm
        {...props}
        recipients={[{ ...ownerRecipient, role: 'STAFF' }]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Existing account recipient'), { target: { value: 'user-a' } })
    expect(screen.getByRole('checkbox', { name: /Content history/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('checkbox', { name: /Venue packages/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByText(/Manager or owner recipients only/)).toHaveLength(2)
  })
  it('has a usable no-choice state and preserves narrow controls for long labels', () => {
    const { container } = render(<SupportPortableExportForm tenantId="tenant-a" venues={[]} recipients={[]} sections={props.sections} maxExportBytes={props.maxExportBytes} />)
    expect(screen.getByRole('status').textContent).toContain('A venue is required')
    expect(screen.queryByRole('button', { name: 'Prepare JSON download' })).toBeNull()
    expect(container.querySelector('.overflow-hidden')).toBeTruthy()
  })
})
