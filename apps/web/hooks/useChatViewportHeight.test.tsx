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

  it('undoes any document scroll iOS applied once the keyboard closes', async () => {
    vi.stubGlobal('React', React)
    const viewport = Object.assign(new EventTarget(), {
      height: 768,
      scale: 1,
      offsetTop: 0,
      offsetLeft: 0,
    })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    vi.stubGlobal('scrollY', 0)
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 360
      viewport.offsetTop = 120
      viewport.dispatchEvent(new Event('resize'))
    })
    scrollTo.mockClear()
    vi.stubGlobal('scrollY', 96)
    // Still focused: never fight the scroll Safari used to reveal the field.
    act(() => {
      viewport.height = 768
      viewport.offsetTop = 0
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(scrollTo).not.toHaveBeenCalled()
    await act(async () => screen.getByRole('button').focus())
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('does not restore scroll on blur until the viewport is back near its baseline', async () => {
    vi.stubGlobal('React', React)
    const viewport = Object.assign(new EventTarget(), {
      height: 768,
      scale: 1,
      offsetTop: 0,
      offsetLeft: 0,
    })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    vi.stubGlobal('scrollY', 0)
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 360
      viewport.dispatchEvent(new Event('resize'))
    })
    vi.stubGlobal('scrollY', 96)
    await act(async () => screen.getByRole('button').focus())
    expect(scrollTo).not.toHaveBeenCalled()
    act(() => {
      viewport.height = 760
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('detects the keyboard against the stable baseline when innerHeight shrinks with it', async () => {
    vi.stubGlobal('React', React)
    const viewport = Object.assign(new EventTarget(), {
      height: 768,
      width: 390,
      scale: 1,
      offsetTop: 0,
      offsetLeft: 0,
    })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      vi.stubGlobal('innerHeight', 420)
      viewport.height = 420
      viewport.offsetTop = 40
      window.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 420, offsetTop: 40, offsetLeft: 0 }),
    )
  })

  it('subtracts document scroll from offsetTop and clamps at zero', async () => {
    vi.stubGlobal('React', React)
    const viewport = Object.assign(new EventTarget(), {
      height: 768,
      scale: 1,
      offsetTop: 0,
      offsetLeft: 0,
    })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    vi.stubGlobal('scrollY', 0)
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.offsetTop = 100
      vi.stubGlobal('scrollY', 60)
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 400, offsetTop: 40, offsetLeft: 0 }),
    )
    act(() => {
      vi.stubGlobal('scrollY', 150)
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 400, offsetTop: 0, offsetLeft: 0 }),
    )
  })

  it('resets the baseline on orientation change', async () => {
    vi.stubGlobal('React', React)
    const viewport = Object.assign(new EventTarget(), {
      height: 768,
      width: 390,
      scale: 1,
      offsetTop: 0,
      offsetLeft: 0,
    })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    render(<Probe />)
    act(() => {
      viewport.height = 390
      viewport.width = 768
      viewport.dispatchEvent(new Event('resize'))
    })
    await act(async () => screen.getByRole('textbox').focus())
    // 390 is now the landscape baseline, not a keyboard.
    expect(screen.getByRole('status').textContent).toBe('automatic')
  })
})
