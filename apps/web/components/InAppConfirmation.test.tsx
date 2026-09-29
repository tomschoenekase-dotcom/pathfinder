import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InAppConfirmationProvider, useInAppConfirmationController } from './InAppConfirmation'

const palette = {
  accent: '#123456',
  accentText: '#123456',
  accentContrast: '#ffffff',
  bg: '#ffffff',
  card: '#ffffff',
  border: '#dddddd',
  text: '#111111',
  textMuted: '#666666',
  isDark: false,
} as const

function ConfirmationFixture({ onResult }: { onResult: (confirmed: boolean) => void }) {
  const controller = useInAppConfirmationController()
  return (
    <InAppConfirmationProvider controller={controller} palette={palette}>
      <button
        type="button"
        onClick={() => {
          void controller
            .requestConfirmation({
              title: 'Start a new conversation?',
              message: 'Clear chat? Your visit preferences stay on this page.',
              cancelLabel: 'Cancel',
              confirmLabel: 'New conversation',
            })
            .then(onResult)
        }}
      >
        Clear chat
      </button>
    </InAppConfirmationProvider>
  )
}

describe('InAppConfirmation', () => {
  afterEach(cleanup)

  it('focuses the safe cancel action, traps focus, and restores focus on Escape', async () => {
    const onResult = vi.fn()
    render(<ConfirmationFixture onResult={onResult} />)
    const trigger = screen.getByRole('button', { name: 'Clear chat' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('alertdialog', { name: 'Start a new conversation?' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'New conversation' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.activeElement).toBe(cancel)

    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
    expect(document.activeElement).toBe(trigger)
  })

  it('resolves true only when the visitor chooses the confirm action', async () => {
    const onResult = vi.fn()
    render(<ConfirmationFixture onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
