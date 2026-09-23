import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatViewportHeight } from './useChatViewportHeight'

function Probe() {
  const viewportRect = useChatViewportHeight()
  return (
    <>
      <output>{viewportRect ? JSON.stringify(viewportRect) : 'automatic'}</output>
      <textarea aria-label="Draft" />
      <button>Other action</button>
    </>
  )
}

describe('chat keyboard viewport', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('uses the visible keyboard height, restores normal height, and leaves pinch zoom alone', async () => {
    vi.stubGlobal('React', React)
    const viewport = Object.assign(new EventTarget(), {
      height: 768,
      scale: 1,
      offsetTop: 0,
      offsetLeft: 0,
    })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    render(<Probe />)
    expect(screen.getByRole('status').textContent).toBe('automatic')
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 360
      viewport.offsetTop = 148
      viewport.offsetLeft = 12
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 360, offsetTop: 148, offsetLeft: 12 }),
    )
    act(() => {
      viewport.offsetTop = 132
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 360, offsetTop: 132, offsetLeft: 12 }),
    )
    act(() => {
      viewport.scale = 2
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByRole('status').textContent).toBe('automatic')
    act(() => {
      viewport.scale = 1
      viewport.dispatchEvent(new Event('resize'))
    })
    await act(async () => screen.getByRole('button').focus())
    expect(screen.getByRole('status').textContent).toBe('automatic')
  })
})
