/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ addNote: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { addChatlogNote: { mutate: mocks.addNote } } }),
}))

import { AdminChatlogNoteForm } from './AdminChatlogNoteForm'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('AdminChatlogNoteForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('retains the request ID across an ambiguous failure and rotates it after success', async () => {
    mocks.addNote
      .mockRejectedValueOnce(new Error('Transport failed'))
      .mockResolvedValueOnce({
        id: '11111111-1111-4111-8111-111111111111',
        note: 'Private detail',
        authorId: 'admin-1',
        createdAt: new Date('2026-08-11T20:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: '22222222-2222-4222-8222-222222222222',
        note: 'Second detail',
        authorId: 'admin-1',
        createdAt: new Date('2026-08-11T20:01:00.000Z'),
      })

    render(
      <AdminChatlogNoteForm
        tenantId="tenant-1"
        venueId="venue-1"
        sessionId="session-1"
        initialNotes={[]}
      />,
    )

    const input = screen.getByRole('textbox', { name: 'Private admin note' })
    fireEvent.change(input, { target: { value: 'Private detail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Transport failed')

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(mocks.addNote).toHaveBeenCalledTimes(2))
    expect(mocks.addNote.mock.calls[0]?.[0].requestId).toBe('11111111-1111-4111-8111-111111111111')
    expect(mocks.addNote.mock.calls[1]?.[0].requestId).toBe('11111111-1111-4111-8111-111111111111')
    expect(await screen.findByText('Private detail')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'Second detail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(mocks.addNote).toHaveBeenCalledTimes(3))
    expect(mocks.addNote.mock.calls[2]?.[0].requestId).toBe('22222222-2222-4222-8222-222222222222')
  })

  it('rotates the request ID when the note changes after an ambiguous failure', async () => {
    mocks.addNote.mockRejectedValueOnce(new Error('Transport failed')).mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      note: 'Edited detail',
      authorId: 'admin-1',
      createdAt: new Date('2026-08-11T20:01:00.000Z'),
    })
    render(
      <AdminChatlogNoteForm
        tenantId="tenant-1"
        venueId="venue-1"
        sessionId="session-1"
        initialNotes={[]}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Private admin note' })
    fireEvent.change(input, { target: { value: 'Original detail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await screen.findByText('Transport failed')
    fireEvent.change(input, { target: { value: 'Edited detail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(mocks.addNote).toHaveBeenCalledTimes(2))
    expect(mocks.addNote.mock.calls[0]?.[0].requestId).toBe('11111111-1111-4111-8111-111111111111')
    expect(mocks.addNote.mock.calls[1]?.[0].requestId).toBe('22222222-2222-4222-8222-222222222222')
  })

  it('synchronously fences same-tick duplicate submissions', async () => {
    const pending = deferred<{
      id: string
      note: string
      authorId: string
      createdAt: Date
    }>()
    mocks.addNote.mockReturnValueOnce(pending.promise)
    render(
      <AdminChatlogNoteForm
        tenantId="tenant-1"
        venueId="venue-1"
        sessionId="session-1"
        initialNotes={[]}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Private admin note' }), {
      target: { value: 'Private detail' },
    })
    const form = screen.getByRole('button', { name: 'Add note' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(mocks.addNote).toHaveBeenCalledOnce()
    pending.resolve({
      id: '11111111-1111-4111-8111-111111111111',
      note: 'Private detail',
      authorId: 'admin-1',
      createdAt: new Date('2026-08-11T20:00:00.000Z'),
    })
    await waitFor(() => expect(screen.getByText('Private detail')).toBeTruthy())
    expect(screen.getAllByText('Private detail')).toHaveLength(1)
  })
})
