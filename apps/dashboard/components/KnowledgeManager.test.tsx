/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    knowledge: {
      create: { mutate: mocks.create },
      update: { mutate: mocks.update },
      delete: { mutate: mocks.delete },
    },
  }),
}))

vi.mock('./ContentHistoryPanel', () => ({
  ContentHistoryPanel: ({
    entityType,
    entityId,
    title,
  }: {
    entityType: string
    entityId: string
    title: string
  }) => <div>{`${entityType}:${entityId}:${title}`}</div>,
}))

import { KnowledgeManager } from './KnowledgeManager'

const venueId = 'clxvenue00000000000000001'
const entry = {
  id: 'clxentry000000000000000001',
  venueId,
  title: 'Visitor hours',
  category: 'Visitor Etiquette',
  content: 'The museum opens at nine.',
  isEnabled: true,
  updatedAt: new Date('2026-08-11T14:30:00.000Z'),
}

describe('KnowledgeManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.create.mockResolvedValue({})
    mocks.update.mockResolvedValue({})
    mocks.delete.mockResolvedValue({})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('creates an enabled entry with the exact venue-scoped payload and resets after success', async () => {
    render(<KnowledgeManager venueId={venueId} initialEntries={[]} />)

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Quiet hours' } })
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'Visitor Etiquette' },
    })
    fireEvent.change(screen.getByLabelText('Content'), {
      target: { value: 'Please keep voices low after six.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create entry' }))

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        venueId,
        title: 'Quiet hours',
        category: 'Visitor Etiquette',
        content: 'Please keep voices low after six.',
        isEnabled: true,
      }),
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>('Category').value).toBe('FAQ')
  })

  it('preserves a custom category and submits the exact edit payload without venue authority', async () => {
    render(<KnowledgeManager venueId={venueId} initialEntries={[entry]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Visitor hours' }))
    expect(screen.getByLabelText<HTMLInputElement>('Category').value).toBe('Visitor Etiquette')
    fireEvent.change(screen.getByLabelText('Content'), {
      target: { value: 'Updated hours guidance.' },
    })
    fireEvent.click(screen.getByLabelText('Enabled'))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        id: entry.id,
        venueId,
        expectedUpdatedAt: entry.updatedAt,
        title: 'Visitor hours',
        category: 'Visitor Etiquette',
        content: 'Updated hours guidance.',
        isEnabled: false,
      }),
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Create entry' })).toBeTruthy()
  })

  it('fences duplicate enabled-state writes while the first update is pending', async () => {
    let resolveUpdate!: () => void
    mocks.update.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveUpdate = resolve)),
    )
    render(<KnowledgeManager venueId={venueId} initialEntries={[entry]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Disable Visitor hours' }))
    const pending = await screen.findByRole('button', { name: 'Updating Visitor hours' })
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(pending)
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledWith({
      id: entry.id,
      venueId,
      expectedUpdatedAt: entry.updatedAt,
      isEnabled: false,
    })

    await act(async () => resolveUpdate())
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
    expect(
      (screen.getByRole('button', { name: 'Disable Visitor hours' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('keeps failed form input and exposes mutation errors as an alert', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Save failed safely'))
    render(<KnowledgeManager venueId={venueId} initialEntries={[]} />)

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Keep this title' } })
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Keep this content' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create entry' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Save failed safely')
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('Keep this title')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('keeps edit mode and changed input when an update fails', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Edit conflict'))
    render(<KnowledgeManager venueId={venueId} initialEntries={[entry]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Visitor hours' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unsaved title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Edit conflict')
    expect(screen.getByRole('heading', { name: 'Edit entry' })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('Unsaved title')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('cancels deletion without a mutation and truthfully confirms the recovery path', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<KnowledgeManager venueId={venueId} initialEntries={[entry]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Visitor hours' }))
    expect(mocks.delete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Show history for Visitor hours' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Visitor hours' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Visitor hours' }))

    expect(confirm).toHaveBeenLastCalledWith(
      'Delete "Visitor hours"? You can restore it later from Deleted content on the venue page.',
    )
    await waitFor(() =>
      expect(mocks.delete).toHaveBeenCalledWith({
        id: entry.id,
        venueId,
        expectedUpdatedAt: entry.updatedAt,
      }),
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Create entry' })).toBeTruthy()
    expect(screen.queryByText(/KNOWLEDGE_ENTRY:/u)).toBeNull()
  })

  it('opens history for the exact knowledge entry and recovers a failed toggle', async () => {
    mocks.update.mockRejectedValueOnce(new Error('Toggle failed safely'))
    render(<KnowledgeManager venueId={venueId} initialEntries={[entry]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show history for Visitor hours' }))
    expect(screen.getByText(`KNOWLEDGE_ENTRY:${entry.id}:Visitor hours history`)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Disable Visitor hours' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Toggle failed safely')
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'Disable Visitor hours' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('fences duplicate deletion while the confirmed mutation is pending', async () => {
    let resolveDelete!: () => void
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.delete.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveDelete = resolve)),
    )
    render(<KnowledgeManager venueId={venueId} initialEntries={[entry]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Visitor hours' }))
    const pending = screen.getByRole('button', { name: 'Delete Visitor hours' })
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    expect(pending.textContent).toBe('Deleting...')
    fireEvent.click(pending)
    expect(confirm).toHaveBeenCalledOnce()
    expect(mocks.delete).toHaveBeenCalledOnce()
    expect(mocks.refresh).not.toHaveBeenCalled()

    await act(async () => resolveDelete())
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
  })

  it('fences every mutating action while a different mutation is pending', async () => {
    let resolveUpdate!: () => void
    const confirm = vi.spyOn(window, 'confirm')
    mocks.update.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveUpdate = resolve)),
    )
    render(<KnowledgeManager venueId={venueId} initialEntries={[entry]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Visitor hours' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
    const toggle = screen.getByRole('button', { name: 'Disable Visitor hours' })
    const deleteButton = screen.getByRole('button', { name: 'Delete Visitor hours' })
    const newEntry = screen.getByRole('button', { name: 'New entry' })
    const title = screen.getByLabelText('Title')
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true)
    expect((newEntry as HTMLButtonElement).disabled).toBe(true)
    expect((title as HTMLInputElement).disabled).toBe(true)

    fireEvent.click(toggle)
    fireEvent.click(deleteButton)
    fireEvent.submit(screen.getByRole('button', { name: 'Saving...' }).closest('form')!)
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.delete).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()

    await act(async () => resolveUpdate())
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
  })
})
