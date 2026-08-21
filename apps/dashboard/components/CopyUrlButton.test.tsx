/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { CopyUrlButton } from './CopyUrlButton'

describe('CopyUrlButton', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('copies the exact URL and announces success without changing the control name', async () => {
    writeText.mockResolvedValueOnce(undefined)
    render(<CopyUrlButton url="https://guide.example.com/museum/chat" />)

    const button = screen.getByRole('button', { name: 'Copy guest chat URL' })
    fireEvent.click(button)

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://guide.example.com/museum/chat'),
    )
    expect((await screen.findByRole('status')).textContent).toBe('Guest chat URL copied.')
    expect(screen.getByRole('button', { name: 'Copy guest chat URL' })).toBeTruthy()
  })

  it('keeps retry available and announces clipboard rejection', async () => {
    writeText.mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined)
    render(<CopyUrlButton url="https://guide.example.com/museum/chat" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy guest chat URL' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not copy the guest chat URL. Try again or select the URL manually.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy guest chat URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect((await screen.findByRole('status')).textContent).toBe('Guest chat URL copied.')
  })

  it('handles an unavailable Clipboard API without an unhandled rejection', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    render(<CopyUrlButton url="https://guide.example.com/museum/chat" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy guest chat URL' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy guest chat URL' })).toBeTruthy()
  })

  it('disables duplicate writes while one copy attempt is pending', async () => {
    let resolveCopy: (() => void) | undefined
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve
        }),
    )
    render(<CopyUrlButton url="https://guide.example.com/museum/chat" />)

    const button = screen.getByRole('button', { name: 'Copy guest chat URL' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(writeText).toHaveBeenCalledOnce()
    expect((button as HTMLButtonElement).disabled).toBe(true)
    resolveCopy?.()
    await screen.findByText('Copied')
  })

  it('ignores an old clipboard completion after the URL changes', async () => {
    let resolveFirst: (() => void) | undefined
    writeText
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValueOnce(undefined)
    const { rerender } = render(<CopyUrlButton url="https://guide.example.com/old/chat" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy guest chat URL' }))
    rerender(<CopyUrlButton url="https://guide.example.com/new/chat" />)
    expect(
      (screen.getByRole('button', { name: 'Copy guest chat URL' }) as HTMLButtonElement).disabled,
    ).toBe(false)

    await act(async () => {
      resolveFirst?.()
      await Promise.resolve()
    })
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Copy guest chat URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText).toHaveBeenLastCalledWith('https://guide.example.com/new/chat')
  })

  it('does not schedule state cleanup after an in-flight copy unmounts', async () => {
    vi.useFakeTimers()
    let resolveCopy: (() => void) | undefined
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve
        }),
    )
    const { unmount } = render(<CopyUrlButton url="https://guide.example.com/museum/chat" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy guest chat URL' }))
    unmount()

    await act(async () => {
      resolveCopy?.()
      await Promise.resolve()
    })

    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns the successful control to idle after the bounded status interval', async () => {
    vi.useFakeTimers()
    writeText.mockResolvedValueOnce(undefined)
    render(<CopyUrlButton url="https://guide.example.com/museum/chat" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy guest chat URL' }))
      await Promise.resolve()
    })
    expect(screen.getByText('Copied')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Guest chat URL copied.')

    act(() => vi.advanceTimersByTime(1999))
    expect(screen.getByText('Copied')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Copy')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
