/** @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const mutate = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      listAgentQuestionDiscussion: { query },
      appendAgentQuestionDiscussion: { mutate },
    },
  }),
}))

import { AgentQuestionDiscussion } from './AgentQuestionDiscussion'
;(globalThis as typeof globalThis & { React: typeof React }).React = React
const scope = { tenantId: 'tenant-a', venueId: 'venue-a', questionId: 'question-a' }
const note = {
  id: 'note-a',
  authorId: 'operator-a',
  body: 'Check the north entrance map.',
  createdAt: new Date('2026-09-08T12:00:00Z'),
}
function open(container: HTMLElement) {
  const details = container.querySelector('details')!
  details.open = true
}
async function renderOpen() {
  const result = render(<AgentQuestionDiscussion {...scope} />)
  open(result.container)
  await screen.findByText('No discussion notes yet.')
  return result
}
function send(body = note.body) {
  fireEvent.change(screen.getByLabelText('Add an operator note'), { target: { value: body } })
  fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
}

describe('AgentQuestionDiscussion', () => {
  beforeEach(() => {
    query.mockResolvedValue({ items: [], nextCursor: null })
  })
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('loads only when opened, sends exact scope, and reads persisted notes on remount', async () => {
    query.mockResolvedValue({ items: [note], nextCursor: null })
    const first = render(<AgentQuestionDiscussion {...scope} />)
    expect(query).not.toHaveBeenCalled()
    open(first.container)
    expect(await screen.findByText(note.body)).toBeTruthy()
    expect(query).toHaveBeenCalledWith({ ...scope, limit: 20 })
    first.unmount()
    const second = render(<AgentQuestionDiscussion {...scope} />)
    open(second.container)
    expect(await screen.findByText(note.body)).toBeTruthy()
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('saves a note without calling answer, refresh, or dispatch interfaces', async () => {
    mutate.mockResolvedValue({ message: note, replayed: false })
    await renderOpen()
    send(`  ${note.body}  `)
    expect(
      await screen.findByText('Note saved. The question and its answer are unchanged.'),
    ).toBeTruthy()
    expect(mutate).toHaveBeenCalledWith({
      ...scope,
      operationId: expect.any(String),
      body: note.body,
    })
    expect((screen.getByLabelText('Add an operator note') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByText(note.body)).toBeTruthy()
  })

  it('freezes the exact operation and body after a lost acknowledgement and retries without duplication', async () => {
    mutate
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValueOnce({ message: note, replayed: true })
    await renderOpen()
    send()
    const retry = await screen.findByRole('button', { name: 'Retry same note' })
    const initial = mutate.mock.calls[0]![0]
    expect((screen.getByLabelText('Add an operator note') as HTMLTextAreaElement).disabled).toBe(
      true,
    )
    fireEvent.click(retry)
    await screen.findByText('Note saved. The question and its answer are unchanged.')
    expect(mutate.mock.calls[1]![0]).toEqual(initial)
    expect(screen.getAllByText(note.body)).toHaveLength(1)
  })

  it('does not turn a read failure into an empty discussion', async () => {
    query.mockRejectedValueOnce(new Error('offline'))
    const { container } = render(<AgentQuestionDiscussion {...scope} />)
    open(container)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('No discussion notes yet.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh notes' }))
    expect(await screen.findByText('No discussion notes yet.')).toBeTruthy()
  })

  it('paginates with the returned stable cursor and deduplicates overlapping rows', async () => {
    const cursor = { createdAt: note.createdAt.toISOString(), id: note.id }
    query.mockResolvedValueOnce({ items: [note], nextCursor: cursor }).mockResolvedValueOnce({
      items: [note, { ...note, id: 'older', body: 'Older operator context' }],
      nextCursor: null,
    })
    const { container } = render(<AgentQuestionDiscussion {...scope} />)
    open(container)
    fireEvent.click(await screen.findByRole('button', { name: 'Load older notes' }))
    expect(await screen.findByText('Older operator context')).toBeTruthy()
    expect(query.mock.calls[1]![0]).toEqual({ ...scope, limit: 20, cursor })
    expect(screen.getAllByText(note.body)).toHaveLength(1)
  })

  it('fences a late mutation from another question and resets the editor and uncertain retry', async () => {
    let finish!: (value: unknown) => void
    mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const { container, rerender } = await renderOpen()
    send()
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    rerender(<AgentQuestionDiscussion {...scope} questionId="question-b" />)
    open(container)
    await screen.findByText('No discussion notes yet.')
    await act(async () => finish({ message: note, replayed: false }))
    expect(screen.queryByText(note.body)).toBeNull()
    expect(screen.queryByText('Note saved. The question and its answer are unchanged.')).toBeNull()
    expect((screen.getByLabelText('Add an operator note') as HTMLTextAreaElement).value).toBe('')
    expect(query.mock.calls.at(-1)![0].questionId).toBe('question-b')
  })

  it('keeps untrusted note text as plain text and blocks blank submissions', async () => {
    query.mockResolvedValue({
      items: [{ ...note, body: '<script>alert(1)</script>' }],
      nextCursor: null,
    })
    const { container } = render(<AgentQuestionDiscussion {...scope} />)
    open(container)
    expect(await screen.findByText('<script>alert(1)</script>')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
    expect((screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(mutate).not.toHaveBeenCalled()
  })
})
