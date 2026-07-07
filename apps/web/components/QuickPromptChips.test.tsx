import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { QuickPromptChips, buildPrompts } from './QuickPromptChips'

describe('QuickPromptChips', () => {
  it('calls onSend with the selected prompt text', () => {
    const onSend = vi.fn()

    render(<QuickPromptChips onSend={onSend} />)

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
})
