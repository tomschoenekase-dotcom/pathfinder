/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  setMode: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  client: {
    tenant: { setEngagementMode: { mutate: vi.fn() } },
    engagementQuestion: {
      create: { mutate: vi.fn() },
      update: { mutate: vi.fn() },
      delete: { mutate: vi.fn() },
    },
  },
}))

mocks.client.tenant.setEngagementMode.mutate = mocks.setMode
mocks.client.engagementQuestion.create.mutate = mocks.create
mocks.client.engagementQuestion.update.mutate = mocks.update
mocks.client.engagementQuestion.delete.mutate = mocks.remove

vi.mock('../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))

import { EngagementQuestionsManager } from './EngagementQuestionsManager'

const existingQuestion = {
  id: 'question-1',
  questionType: 'OPEN_ENDED' as const,
  prompt: 'What stood out?',
  choiceOptions: [],
  intensity: 3,
  isActive: true,
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const updatedQuestion = {
  ...existingQuestion,
  prompt: 'Updated prompt',
  createdAt: new Date(existingQuestion.createdAt),
  updatedAt: new Date('2026-08-09T01:00:00.000Z'),
}

describe('EngagementQuestionsManager', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('changes mode only after the server confirms and retains mode on failure', async () => {
    mocks.setMode.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Mode conflict'))
    render(<EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[]} />)

    const balanced = screen.getByRole('button', { name: /^Balanced\b/ })
    const curious = screen.getByRole('button', { name: /^Curious\b/ })
    expect(balanced.className).toContain('border-pf-accent')
    fireEvent.click(curious)
    await waitFor(() => expect(mocks.setMode).toHaveBeenCalledWith({ mode: 'CURIOUS' }))
    expect(curious.className).toContain('border-pf-accent')

    fireEvent.click(screen.getByRole('button', { name: /^Stoic\b/ }))
    expect(await screen.findByText('Mode conflict')).toBeTruthy()
    expect(curious.className).toContain('border-pf-accent')
  })

  it('normalizes a multiple-choice question payload and resets after creation', async () => {
    mocks.create.mockResolvedValueOnce({
      id: 'question-new',
      questionType: 'MULTIPLE_CHOICE',
      prompt: 'Favorite?',
      choiceOptions: ['Art', 'History'],
      intensity: 4,
      isActive: true,
      createdAt: new Date('2026-08-09T01:00:00.000Z'),
      updatedAt: new Date('2026-08-09T01:00:00.000Z'),
    })
    render(<EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Soft multiple-choice' }))
    fireEvent.change(
      screen.getByPlaceholderText(
        "e.g. Ask what the guest's favorite part of the visit was, so we can learn what resonates most.",
      ),
      {
        target: { value: '  Favorite?  ' },
      },
    )
    fireEvent.change(screen.getByPlaceholderText('Option 1'), { target: { value: ' Art ' } })
    fireEvent.change(screen.getByPlaceholderText('Option 2'), {
      target: { value: ' History ' },
    })
    fireEvent.change(screen.getByRole('slider'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith({
      questionType: 'MULTIPLE_CHOICE',
      prompt: 'Favorite?',
      choiceOptions: ['Art', 'History'],
      intensity: 4,
    })
    expect(await screen.findByDisplayValue('Favorite?')).toBeTruthy()
    expect(
      (
        screen.getByPlaceholderText(
          "e.g. Ask what the guest's favorite part of the visit was, so we can learn what resonates most.",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('')
  })

  it('blocks a multiple-choice question after normalization leaves fewer than two options', () => {
    render(<EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Soft multiple-choice' }))
    fireEvent.change(
      screen.getByPlaceholderText(
        "e.g. Ask what the guest's favorite part of the visit was, so we can learn what resonates most.",
      ),
      { target: { value: 'Favorite?' } },
    )
    fireEvent.change(screen.getByPlaceholderText('Option 1'), { target: { value: 'Art' } })
    fireEvent.change(screen.getByPlaceholderText('Option 2'), { target: { value: '   ' } })

    const add = screen.getByRole('button', { name: 'Add question' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.click(add)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('requires confirmation before deleting a question', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[existingQuestion]} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(confirm).toHaveBeenCalledWith('Delete this engagement question? This cannot be undone.')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('What stood out?')).toBeTruthy()
  })

  it('synchronously fences duplicate updates, sends the loaded revision, and locks the editor', async () => {
    const pending = deferred<typeof updatedQuestion>()
    mocks.update.mockReturnValueOnce(pending.promise)
    render(
      <EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[existingQuestion]} />,
    )

    const prompt = screen.getByDisplayValue('What stood out?')
    fireEvent.change(prompt, { target: { value: 'Updated prompt' } })
    const save = screen.getByRole('button', { name: 'Save' })
    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existingQuestion.id,
        expectedUpdatedAt: new Date(existingQuestion.updatedAt),
        prompt: 'Updated prompt',
      }),
    )

    const editor = screen.getByRole('button', { name: 'Saving...' }).closest('[aria-busy="true"]')
    expect(editor).not.toBeNull()
    expect(
      [...editor!.querySelectorAll('button, input, textarea')].every(
        (control) =>
          (control as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement).disabled,
      ),
    ).toBe(true)

    pending.resolve(updatedQuestion)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
  })

  it('retains a stale update draft after conflict and gives safe refresh guidance', async () => {
    mocks.update.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
    render(
      <EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[existingQuestion]} />,
    )

    const prompt = screen.getByDisplayValue('What stood out?')
    fireEvent.change(prompt, { target: { value: 'Updated prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Refresh the page to reconcile your draft.',
    )
    expect(screen.getByDisplayValue('Updated prompt')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
    expect(mocks.update).toHaveBeenCalledOnce()
  })

  it('retains an update draft after transport failure and allows retry', async () => {
    mocks.update
      .mockRejectedValueOnce(new Error('Transport failed'))
      .mockResolvedValueOnce(updatedQuestion)
    render(
      <EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[existingQuestion]} />,
    )

    const prompt = screen.getByDisplayValue('What stood out?')
    fireEvent.change(prompt, { target: { value: 'Updated prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Transport failed')
    expect(screen.getByDisplayValue('Updated prompt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
  })

  it('prevents save/delete overlap before React rerenders', () => {
    const pending = deferred<typeof updatedQuestion>()
    mocks.update.mockReturnValueOnce(pending.promise)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[existingQuestion]} />,
    )

    const save = screen.getByRole('button', { name: 'Save' })
    const remove = screen.getByRole('button', { name: 'Delete' })
    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.update).toHaveBeenCalledOnce()
    expect(confirm).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('sends the loaded revision on delete and retains the card after conflict', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.remove.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
    render(
      <EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[existingQuestion]} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(mocks.remove).toHaveBeenCalledWith({
      id: existingQuestion.id,
      expectedUpdatedAt: new Date(existingQuestion.updatedAt),
    })
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Refresh the page to reconcile your draft.',
    )
    expect(screen.getByDisplayValue('What stood out?')).toBeTruthy()
  })

  it('synchronously fences duplicate creates, locks the draft, and allows retry', async () => {
    const pending = deferred<{
      id: string
      questionType: 'OPEN_ENDED'
      prompt: string
      choiceOptions: string[]
      intensity: number
      isActive: boolean
      createdAt: Date
      updatedAt: Date
    }>()
    mocks.create.mockReturnValueOnce(pending.promise)
    render(<EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[]} />)

    const prompt = screen.getByPlaceholderText(
      "e.g. Ask what the guest's favorite part of the visit was, so we can learn what resonates most.",
    )
    fireEvent.change(prompt, { target: { value: 'What surprised you?' } })
    const add = screen.getByRole('button', { name: 'Add question' })
    act(() => {
      add.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      add.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(mocks.create).toHaveBeenCalledOnce()
    const form = screen.getByRole('button', { name: 'Adding...' }).closest('form')
    expect(form?.getAttribute('aria-busy')).toBe('true')
    expect(
      [...form!.querySelectorAll('button, input, textarea')].every(
        (control) =>
          (control as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement).disabled,
      ),
    ).toBe(true)

    pending.reject(new Error('Transport failed'))
    expect((await screen.findByRole('alert')).textContent).toContain('Transport failed')
    expect(screen.getByDisplayValue('What surprised you?')).toBeTruthy()

    mocks.create.mockResolvedValueOnce({
      id: 'question-new',
      questionType: 'OPEN_ENDED',
      prompt: 'What surprised you?',
      choiceOptions: [],
      intensity: 3,
      isActive: true,
      createdAt: new Date('2026-08-09T01:00:00.000Z'),
      updatedAt: new Date('2026-08-09T01:00:00.000Z'),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
  })

  it('synchronously fences mode changes and suppresses late state after unmount', async () => {
    const pending = deferred<undefined>()
    mocks.setMode.mockReturnValueOnce(pending.promise)
    const view = render(<EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[]} />)

    const curious = screen.getByRole('button', { name: /^Curious\b/ })
    const stoic = screen.getByRole('button', { name: /^Stoic\b/ })
    act(() => {
      curious.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      stoic.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.setMode).toHaveBeenCalledOnce()
    expect(mocks.setMode).toHaveBeenCalledWith({ mode: 'CURIOUS' })
    expect(
      screen
        .getAllByRole('button', { name: /^(Stoic|Balanced|Curious)\b/ })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)

    view.unmount()
    pending.resolve(undefined)
    await act(async () => pending.promise)
  })

  it('suppresses a late update callback after unmount', async () => {
    const pending = deferred<typeof updatedQuestion>()
    mocks.update.mockReturnValueOnce(pending.promise)
    const view = render(
      <EngagementQuestionsManager initialMode="BALANCED" initialQuestions={[existingQuestion]} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    view.unmount()
    pending.resolve(updatedQuestion)
    await act(async () => pending.promise)
  })
})
