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

  it('positions the shell from the visual viewport alone: document scroll is not part of it', async () => {
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
    // iOS scrolled the document 60px to reveal the field and panned the visual viewport 100px.
    // Both the shell (position: fixed) and offsetTop use layout-viewport coordinates, so the shell
    // goes to 100, not 100 - 60 (the old formula left the composer far above the keyboard).
    act(() => {
      viewport.height = 400
      viewport.offsetTop = 100
      vi.stubGlobal('scrollY', 60)
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 400, offsetTop: 100, offsetLeft: 0 }),
    )
    // A larger scroll changes nothing about where the visible area is.
    act(() => {
      vi.stubGlobal('scrollY', 150)
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 400, offsetTop: 100, offsetLeft: 0 }),
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

/** A shell and transcript whose geometry the test controls, as a browser would report it. */
function GeometryProbe() {
  const rect = useChatViewportHeight()
  return (
    <div
      data-chat-shell
      data-keyboard-open={rect ? true : undefined}
      style={
        {
          '--chat-keyboard-offset-y': rect ? `${rect.offsetTop}px` : undefined,
          '--chat-keyboard-offset-x': rect ? `${rect.offsetLeft}px` : undefined,
        } as React.CSSProperties
      }
    >
      <output>{rect ? JSON.stringify(rect) : 'automatic'}</output>
      <div data-chat-conversation />
      <textarea aria-label="Draft" />
      <button>Other action</button>
    </div>
  )
}

/** The offset the shell currently carries, as a stylesheet would position it. */
function carriedOffset(shell: HTMLElement) {
  return Number.parseFloat(shell.style.getPropertyValue('--chat-keyboard-offset-y') || '0')
}

function installFrames() {
  const queue: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queue.push(callback)
    return queue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  return () => {
    // One frame per act, so React commits between frames exactly as it does in a browser.
    for (let guard = 0; guard < 20 && queue.length > 0; guard += 1) {
      act(() => {
        const batch = queue.splice(0)
        for (const callback of batch) callback(0)
      })
    }
  }
}

function makeViewport(height = 768) {
  return Object.assign(new EventTarget(), {
    height,
    width: 390,
    scale: 1,
    offsetTop: 0,
    offsetLeft: 0,
  })
}

describe('chat keyboard geometry', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('corrects the measured gap between the shell and the visual viewport, then stops', async () => {
    vi.stubGlobal('React', React)
    const flush = installFrames()
    const viewport = makeViewport()
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    vi.stubGlobal('scrollY', 0)
    const { container } = render(<GeometryProbe />)
    const shell = container.querySelector('[data-chat-shell]') as HTMLElement
    // This browser renders the fixed shell 30px above where its CSS top says it should be: the
    // measured gap is what gets corrected, whatever the cause.
    let rendered = 0
    vi.spyOn(shell, 'getBoundingClientRect').mockImplementation(() => {
      rendered += 1
      return {
        top: carriedOffset(shell) - 30,
        left: 0,
        bottom: 0,
        right: 0,
        width: 0,
        height: 0,
      } as DOMRect
    })
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.offsetTop = 200
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    // One pass closes a constant 30px residual; the next measures zero and nothing moves again.
    expect(JSON.parse(screen.getByRole('status').textContent!)).toMatchObject({
      height: 400,
      offsetTop: 230,
    })
    const settled = screen.getByRole('status').textContent
    flush()
    expect(screen.getByRole('status').textContent).toBe(settled)
    expect(rendered).toBeGreaterThan(0)
  })

  it('leaves the shell alone when the measured geometry already agrees', async () => {
    vi.stubGlobal('React', React)
    const flush = installFrames()
    const viewport = makeViewport()
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    vi.stubGlobal('scrollY', 0)
    const { container } = render(<GeometryProbe />)
    const shell = container.querySelector('[data-chat-shell]') as HTMLElement
    vi.spyOn(shell, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: carriedOffset(shell),
          left: 0,
          bottom: 0,
          right: 0,
          width: 0,
          height: 0,
        }) as DOMRect,
    )
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.offsetTop = 120
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 400, offsetTop: 120, offsetLeft: 0 }),
    )
  })

  it('does not chase a measurement that ignores the correction: it restores the plain geometry', async () => {
    vi.stubGlobal('React', React)
    const flush = installFrames()
    const viewport = makeViewport()
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    vi.stubGlobal('scrollY', 0)
    // No mock: this environment reports a shell at 0 whatever its offset is (for example no
    // stylesheet), so the measurement says nothing about where the shell really is.
    render(<GeometryProbe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.offsetTop = 150
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 400, offsetTop: 150, offsetLeft: 0 }),
    )
  })

  it('refuses a correction larger than the viewport: that is another frame, not a nudge', async () => {
    vi.stubGlobal('React', React)
    const flush = installFrames()
    const viewport = makeViewport()
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    vi.stubGlobal('scrollY', 0)
    const { container } = render(<GeometryProbe />)
    const shell = container.querySelector('[data-chat-shell]') as HTMLElement
    vi.spyOn(shell, 'getBoundingClientRect').mockImplementation(
      () => ({ top: -5_000, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) as DOMRect,
    )
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.offsetTop = 100
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ height: 400, offsetTop: 100, offsetLeft: 0 }),
    )
  })

  it('keeps the latest messages visible: re-pins a following transcript, leaves a reader who scrolled up', async () => {
    vi.stubGlobal('React', React)
    const flush = installFrames()
    const viewport = makeViewport()
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    vi.stubGlobal('scrollY', 0)
    const { container } = render(<GeometryProbe />)
    const transcript = container.querySelector('[data-chat-conversation]') as HTMLElement
    const geometry = (scrollTop: number) => {
      Object.defineProperty(transcript, 'scrollHeight', { value: 2_000, configurable: true })
      Object.defineProperty(transcript, 'clientHeight', { value: 500, configurable: true })
      transcript.scrollTop = scrollTop
    }
    // Following the latest message (1,500 of 2,000, a viewport of 500, is the very end).
    geometry(1_500)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.offsetTop = 0
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    expect(transcript.scrollTop).toBe(2_000)

    // Dismiss the keyboard, scroll up to read, then open it again: the reader is not yanked.
    await act(async () => screen.getByRole('button').focus())
    act(() => {
      viewport.height = 768
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    geometry(200)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    expect(transcript.scrollTop).toBe(200)
  })

  it('does not drift across repeated focus, send and dismiss cycles', async () => {
    vi.stubGlobal('React', React)
    const flush = installFrames()
    const viewport = makeViewport()
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 768)
    vi.stubGlobal('scrollY', 0)
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    render(<GeometryProbe />)
    const opened: string[] = []
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await act(async () => screen.getByRole('textbox').focus())
      act(() => {
        viewport.height = 380
        viewport.offsetTop = 150
        viewport.dispatchEvent(new Event('resize'))
      })
      flush()
      opened.push(screen.getByRole('status').textContent!)
      await act(async () => screen.getByRole('button').focus())
      act(() => {
        viewport.height = 768
        viewport.offsetTop = 0
        viewport.dispatchEvent(new Event('resize'))
      })
      flush()
      // Closed: back to the automatic full-height layout, every time.
      expect(screen.getByRole('status').textContent).toBe('automatic')
    }
    // Every open lands on exactly the same rectangle: nothing accumulates.
    expect(new Set(opened).size).toBe(1)
    expect(JSON.parse(opened[0]!)).toEqual({ height: 380, offsetTop: 150, offsetLeft: 0 })
  })
})
