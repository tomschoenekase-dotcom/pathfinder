import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { QuickPromptChips, buildPrompts } from './QuickPromptChips'

describe('QuickPromptChips', () => {
  afterEach(cleanup)

  it('keeps a named prompt group without another visible instruction heading', () => {
    render(<QuickPromptChips onSend={vi.fn()} />)
    const group = screen.getByRole('region', { name: 'Start with a question' })
    expect(screen.queryByText('Start with a question')).toBeNull()
    expect(group.querySelectorAll('button')).toHaveLength(3)
    expect(group.querySelectorAll('svg[aria-hidden="true"][focusable="false"]')).toHaveLength(3)
    expect(group.textContent).not.toContain('↗')
  })

  it('retains the localized prompt group and explicit selection', () => {
    const onSend = vi.fn()
    render(<QuickPromptChips language="日本語" guideMode="non_location" onSend={onSend} />)
    expect(screen.getByRole('region', { name: '質問から始めましょう' })).toBeTruthy()
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(onSend).toHaveBeenCalledWith(
      buildPrompts(undefined, undefined, 'non_location', '日本語')[0],
    )
  })

  it('calls onSend with the selected prompt text', () => {
    const onSend = vi.fn()

    render(<QuickPromptChips onSend={onSend} />)

    const prompts = screen.getAllByRole('button')
    expect(prompts.every((prompt) => prompt.className.includes('min-h-11'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Where are the restrooms?' }))

    expect(onSend).toHaveBeenCalledWith('Where are the restrooms?')
  })

  it('caps prompts at 3 per language', () => {
    expect(buildPrompts('Riverside Aquarium', 'AQUARIUM')).toEqual([
      "What's worth seeing near me right now?",
      'Where should I go next?',
      'Where are the restrooms?',
    ])
  })

  it('prevents a quick prompt from starting a request while offline', () => {
    const onSend = vi.fn()
    render(<QuickPromptChips onSend={onSend} disabled />)

    const prompt = screen.getByRole('button', { name: 'Where are the restrooms?' })
    expect((prompt as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(prompt)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('offers knowledge prompts when a location-aware venue has no live position', () => {
    expect(
      buildPrompts('Riverside Aquarium', 'AQUARIUM', 'location_aware', 'English', false),
    ).toEqual([
      'What should I know first?',
      'Explain this place to me.',
      'Walk me through what to do when I arrive.',
    ])
  })
})
