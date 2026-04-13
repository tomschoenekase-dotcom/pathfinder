import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { QuickPromptChips } from './QuickPromptChips'

describe('QuickPromptChips', () => {
  it('calls onSend with the selected prompt text', () => {
    const onSend = vi.fn()

    render(<QuickPromptChips onSend={onSend} />)

    fireEvent.click(screen.getByRole('button', { name: 'Where is the nearest bathroom?' }))

    expect(onSend).toHaveBeenCalledWith('Where is the nearest bathroom?')
  })
})
