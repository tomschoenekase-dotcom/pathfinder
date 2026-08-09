/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
})
