import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldDismissKeyboardOnSubmit, useChatViewportHeight } from './useChatViewportHeight'

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

function makeViewport(height = 768) {
  return Object.assign(new EventTarget(), {
    height,
    width: 390,
    scale: 1,
    offsetTop: 0,
    offsetLeft: 0,
  })
}

function setup(height = 768) {
  vi.stubGlobal('React', React)
  const viewport = makeViewport(height)
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('innerHeight', height)
  vi.stubGlobal('scrollY', 0)
  vi.stubGlobal('scrollX', 0)
  const scrollTo = vi.fn()
  vi.stubGlobal('scrollTo', scrollTo)
  return { viewport, scrollTo }
}

const status = () => screen.getByRole('status').textContent

function installFrames() {
  const queue: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queue.push(callback)
    return queue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  return () => {
    for (let guard = 0; guard < 20 && queue.length > 0; guard += 1) {
      act(() => {
        const batch = queue.splice(0)
        for (const callback of batch) callback(0)
      })
    }
  }
}

describe('chat shell follows the visual viewport', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('pins the shell to the visible rectangle while the keyboard is open, then releases it', async () => {
    const { viewport } = setup()
    render(<Probe />)
    expect(status()).toBe('automatic')
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 360
      viewport.offsetTop = 148
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(JSON.parse(status()!)).toEqual({
      height: 360,
      offsetTop: 148,
      offsetLeft: 0,
      keyboardOpen: true,
    })
    // iOS pans further while the visitor types: follow it, nothing accumulates.
    act(() => {
      viewport.offsetTop = 132
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(JSON.parse(status()!)).toMatchObject({ height: 360, offsetTop: 132 })
    await act(async () => screen.getByRole('button').focus())
    act(() => {
      viewport.height = 768
      viewport.offsetTop = 0
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(status()).toBe('automatic')
  })

  it('never measures its own rendered position (iOS reports fixed rects in visual coordinates)', async () => {
    const { viewport } = setup()
    const flush = installFrames()
    // Simulate WebKit on iOS: a fixed element's client rect is relative to the visual viewport,
    // so a correctly placed shell measures top = 0 while offsetTop = 300. The previous hook read
    // this as a 300px residual and moved the shell down a second time (IMG_0341).
    const rects = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => ({ top: 0, left: 0, bottom: 420, right: 390 }) as DOMRect)
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 420
      viewport.offsetTop = 300
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    expect(JSON.parse(status()!)).toMatchObject({ height: 420, offsetTop: 300 })
    expect(rects).not.toHaveBeenCalled()
  })

  it('keeps following a pan iOS leaves behind after the keyboard closes, and releases scroll', async () => {
    const { viewport, scrollTo } = setup()
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 380
      viewport.offsetTop = 260
      viewport.dispatchEvent(new Event('resize'))
    })
    vi.stubGlobal('scrollY', 120)
    await act(async () => screen.getByRole('button').focus())
    // Reported on iOS 26: the keyboard is gone but offsetTop has not returned to 0.
    act(() => {
      viewport.height = 768
      viewport.offsetTop = 40
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(JSON.parse(status()!)).toEqual({
      height: 768,
      offsetTop: 40,
      offsetLeft: 0,
      keyboardOpen: false,
    })
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
    act(() => {
      viewport.offsetTop = 0
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(status()).toBe('automatic')
  })

  it('never scrolls the document while the field is focused', async () => {
    const { viewport, scrollTo } = setup()
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 360
      viewport.offsetTop = 120
      viewport.dispatchEvent(new Event('resize'))
    })
    vi.stubGlobal('scrollY', 96)
    act(() => {
      viewport.height = 768
      viewport.offsetTop = 0
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(scrollTo).not.toHaveBeenCalled()
    await act(async () => screen.getByRole('button').focus())
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('does not release scroll on blur until the viewport is back near its baseline', async () => {
    const { viewport, scrollTo } = setup()
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
    const { viewport } = setup()
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      vi.stubGlobal('innerHeight', 420)
      viewport.height = 420
      viewport.offsetTop = 40
      window.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(JSON.parse(status()!)).toEqual({
      height: 420,
      offsetTop: 40,
      offsetLeft: 0,
      keyboardOpen: true,
    })
  })

  it('positions from the visual viewport alone: document scroll is not part of it', async () => {
    const { viewport } = setup()
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.offsetTop = 100
      vi.stubGlobal('scrollY', 60)
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(JSON.parse(status()!)).toMatchObject({ height: 400, offsetTop: 100 })
    act(() => {
      vi.stubGlobal('scrollY', 150)
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(JSON.parse(status()!)).toMatchObject({ height: 400, offsetTop: 100 })
  })

  it('leaves pinch zoom alone', async () => {
    const { viewport } = setup()
    render(<Probe />)
    act(() => {
      viewport.scale = 2
      viewport.height = 384
      viewport.offsetTop = 200
      viewport.offsetLeft = 90
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(status()).toBe('automatic')
    await act(async () => screen.getByRole('textbox').focus())
    expect(status()).toBe('automatic')
  })

  it('resets the baseline on orientation change', async () => {
    const { viewport } = setup()
    render(<Probe />)
    act(() => {
      vi.stubGlobal('innerHeight', 390)
      viewport.height = 390
      viewport.width = 768
      viewport.dispatchEvent(new Event('resize'))
    })
    await act(async () => screen.getByRole('textbox').focus())
    // 390 is now the landscape baseline, not a keyboard.
    expect(status()).toBe('automatic')
  })

  it('a browser toolbar change without a keyboard is followed without claiming a keyboard', async () => {
    const { viewport } = setup()
    render(<Probe />)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 730
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(JSON.parse(status()!)).toMatchObject({ height: 730, keyboardOpen: false })
  })

  it('removes every listener on unmount', async () => {
    const { viewport } = setup()
    const removed = vi.spyOn(viewport, 'removeEventListener')
    const { unmount } = render(<Probe />)
    unmount()
    expect(removed.mock.calls.map(([name]) => name).sort()).toEqual(['resize', 'scroll'])
    act(() => {
      viewport.height = 300
      viewport.dispatchEvent(new Event('resize'))
    })
  })
})

/** A shell and transcript whose geometry the test controls. */
function GeometryProbe() {
  const rect = useChatViewportHeight()
  return (
    <div data-chat-shell data-keyboard-open={rect?.keyboardOpen ? true : undefined}>
      <output>{rect ? JSON.stringify(rect) : 'automatic'}</output>
      <div data-chat-conversation />
      <textarea aria-label="Draft" />
      <button>Other action</button>
    </div>
  )
}

describe('chat keyboard transcript and cycles', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the latest messages visible: re-pins a following transcript, leaves a reader who scrolled up', async () => {
    const { viewport } = setup()
    const flush = installFrames()
    const { container } = render(<GeometryProbe />)
    const transcript = container.querySelector('[data-chat-conversation]') as HTMLElement
    const geometry = (scrollTop: number) => {
      Object.defineProperty(transcript, 'scrollHeight', { value: 2_000, configurable: true })
      Object.defineProperty(transcript, 'clientHeight', { value: 500, configurable: true })
      transcript.scrollTop = scrollTop
    }
    geometry(1_500)
    await act(async () => screen.getByRole('textbox').focus())
    act(() => {
      viewport.height = 400
      viewport.dispatchEvent(new Event('resize'))
    })
    flush()
    expect(transcript.scrollTop).toBe(2_000)

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

  it('does not drift across ten focus, send and dismiss cycles', async () => {
    const { viewport } = setup()
    const flush = installFrames()
    render(<GeometryProbe />)
    const opened: string[] = []
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await act(async () => screen.getByRole('textbox').focus())
      act(() => {
        viewport.height = 380
        viewport.offsetTop = 150
        viewport.dispatchEvent(new Event('resize'))
      })
      flush()
      opened.push(status()!)
      await act(async () => screen.getByRole('button').focus())
      act(() => {
        viewport.height = 768
        viewport.offsetTop = 0
        viewport.dispatchEvent(new Event('resize'))
      })
      flush()
      expect(status()).toBe('automatic')
    }
    expect(new Set(opened).size).toBe(1)
    expect(JSON.parse(opened[0]!)).toEqual({
      height: 380,
      offsetTop: 150,
      offsetLeft: 0,
      keyboardOpen: true,
    })
  })
})

describe('shouldDismissKeyboardOnSubmit', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  function media(matches: Record<string, boolean>) {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches[query] ?? false }))
  }

  it('dismisses when the shell has detected an open software keyboard', () => {
    media({})
    document.body.innerHTML =
      '<div data-chat-shell data-keyboard-open="true"><textarea></textarea></div>'
    expect(shouldDismissKeyboardOnSubmit(document.querySelector('textarea'))).toBe(true)
  })

  it('dismisses on a touch-only phone even where the keyboard cannot be measured (iframe)', () => {
    media({ '(hover: none) and (pointer: coarse)': true })
    document.body.innerHTML = '<div data-chat-shell><textarea></textarea></div>'
    expect(shouldDismissKeyboardOnSubmit(document.querySelector('textarea'))).toBe(true)
  })

  it('keeps focus on desktop and on a tablet with a trackpad or hardware keyboard', () => {
    document.body.innerHTML = '<div data-chat-shell><textarea></textarea></div>'
    media({})
    expect(shouldDismissKeyboardOnSubmit(document.querySelector('textarea'))).toBe(false)
    media({ '(hover: none) and (pointer: coarse)': true, '(any-pointer: fine)': true })
    expect(shouldDismissKeyboardOnSubmit(document.querySelector('textarea'))).toBe(false)
  })
})
