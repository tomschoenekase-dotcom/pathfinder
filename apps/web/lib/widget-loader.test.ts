import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const READY_MESSAGE = {
  type: 'pathfinder:embed-ready',
  version: 1,
  venueSlug: 'museum',
}
const originalWindowFetch = Object.getOwnPropertyDescriptor(window, 'fetch')
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')
type TorchikoApi = {
  version: number
  open: (options?: { ask?: unknown; place?: unknown }) => void
  close: () => void
  on: (event: 'ready' | 'open' | 'close', listener: () => void) => () => void
}

function api(): TorchikoApi {
  return (window as typeof window & { Torchiko: TorchikoApi }).Torchiko
}

function mockGuideWindow(frame: HTMLIFrameElement) {
  // jsdom leaves iframe.contentWindow null when the frame is inside a shadow root.
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: window })
  return vi.spyOn(window, 'postMessage').mockImplementation(() => undefined)
}

function runWidgetSource() {
  const source = readFileSync(resolve(process.cwd(), 'public/widget.js'), 'utf8')
  runInNewContext(source, { URL, document, encodeURIComponent, window })
}

function executeWidget(params: {
  slug: string | null
  attribute?: 'torchiko' | 'pathfinder'
  inlineSlug?: string
  source?: string
  mounted?: string
  placement?: 'body' | 'head'
  appendInline?: boolean
  inlineHeight?: string
  async?: boolean
}) {
  const script = document.createElement('script')
  if (params.slug !== null)
    script.setAttribute(
      params.attribute === 'torchiko' ? 'data-torchiko-venue' : 'data-pathfinder-venue',
      params.slug,
    )
  let inlineContainer: HTMLDivElement | null = null
  if (params.inlineSlug) {
    inlineContainer = document.createElement('div')
    inlineContainer.setAttribute('data-torchiko-inline', params.inlineSlug)
    if (params.inlineHeight !== undefined) inlineContainer.style.height = params.inlineHeight
    if (params.appendInline !== false) document.body.appendChild(inlineContainer)
  }
  if (params.mounted) script.dataset.pathfinderMounted = params.mounted
  script.src = params.source ?? 'https://guide.example/widget.js'
  if (params.async) script.async = true
  document[params.placement ?? 'body'].appendChild(script)
  Object.defineProperty(document, 'currentScript', {
    configurable: true,
    value: script,
  })

  runWidgetSource()
  const host = document.body?.querySelector<HTMLDivElement>('[data-pathfinder-widget]') ?? null
  const shadow = host?.shadowRoot ?? null
  return {
    close: () => shadow?.querySelector<HTMLButtonElement>('.pf-close') ?? null,
    frame: () => shadow?.querySelector<HTMLIFrameElement>('iframe') ?? null,
    guards: () => shadow?.querySelectorAll<HTMLButtonElement>('.pf-focus-guard') ?? [],
    host,
    launcher: () => shadow?.querySelector<HTMLButtonElement>('.pf-launcher') ?? null,
    panel: () => shadow?.querySelector<HTMLElement>('.pf-panel') ?? null,
    styles: () => shadow?.querySelector<HTMLLinkElement>('link[rel="stylesheet"]') ?? null,
    script,
    shadow,
    inlineContainer,
    inlineFrame: () => inlineContainer?.querySelector<HTMLIFrameElement>('iframe') ?? null,
  }
}

async function completeAvailability(widget: ReturnType<typeof executeWidget>) {
  widget.styles()?.dispatchEvent(new Event('load'))
  await Promise.resolve()
  await Promise.resolve()
}

function dispatchReady(
  frame: HTMLIFrameElement,
  overrides: Partial<typeof READY_MESSAGE> = {},
  options: { origin?: string; source?: MessageEventSource | null } = {},
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { ...READY_MESSAGE, ...overrides },
      origin: options.origin ?? 'https://guide.example',
      source: options.source === undefined ? frame.contentWindow : options.source,
    }),
  )
}

function dispatchBridge(
  frame: HTMLIFrameElement,
  type: string,
  options: {
    origin?: string
    source?: MessageEventSource | null
    payload?: unknown
  } = {},
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: 'torchiko', v: 1, type, payload: options.payload ?? null },
      origin: options.origin ?? 'https://guide.example',
      source: options.source === undefined ? frame.contentWindow : options.source,
    }),
  )
}

describe('classic third-party staging widget launcher', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    document.head
      .querySelectorAll('script[data-pathfinder-venue],script[data-torchiko-venue]')
      .forEach((node) => node.remove())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
          headers: { 'X-PathFinder-Widget-Ready': '1' },
        }),
      ),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (originalWindowFetch) Object.defineProperty(window, 'fetch', originalWindowFetch)
    else Reflect.deleteProperty(window, 'fetch')
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      value: null,
    })
    if (originalVisualViewport)
      Object.defineProperty(window, 'visualViewport', originalVisualViewport)
    else Reflect.deleteProperty(window, 'visualViewport')
    Reflect.deleteProperty(window, 'Torchiko')
  })

  it('reveals an accessible closed launcher only after CSS and venue availability', async () => {
    const widget = executeWidget({ slug: 'museum' })

    expect(widget.host?.hidden).toBe(true)
    expect(widget.script.dataset.pathfinderMounted).toBe('pending')
    expect(fetch).toHaveBeenCalledWith(
      'https://guide.example/api/widget-ready/museum?v=2',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        referrerPolicy: 'no-referrer',
      }),
    )
    expect(widget.styles()?.href).toBe('https://guide.example/widget.css')
    expect(widget.styles()?.referrerPolicy).toBe('no-referrer')

    await completeAvailability(widget)

    expect(widget.host?.hidden).toBe(false)
    expect(widget.host?.getAttribute('data-pathfinder-widget')).toBe('')
    expect(widget.launcher()?.textContent).toBe('Ask Torchiko')
    expect(widget.launcher()?.type).toBe('button')
    expect(widget.launcher()?.getAttribute('aria-expanded')).toBe('false')
    expect(widget.launcher()?.getAttribute('aria-label')).toBe('Ask Torchiko, opens venue guide')
    expect(widget.panel()?.hidden).toBe(true)
    expect(widget.frame()).toBeNull()
    expect(widget.script.dataset.pathfinderMounted).toBe('true')
  })

  it('accepts the Torchiko attribute and applies sanitized probe presentation', async () => {
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            v: 2,
            label: 'Ask the Museum',
            accent: '#0b5cff',
            theme: 'dark',
            background: '#0d1116',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    })
    const widget = executeWidget({ slug: 'museum', attribute: 'torchiko' })
    await completeAvailability(widget)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    expect(widget.launcher()?.textContent).toBe('Ask the Museum')
    expect(widget.host?.style.getPropertyValue('--torchiko-widget-accent')).toBe('#0b5cff')
    expect(widget.host?.style.getPropertyValue('--torchiko-widget-background')).toBe('#0d1116')
    expect(widget.host?.style.getPropertyValue('color-scheme')).toBe('dark')
    expect(widget.launcher()?.textContent).toBe('Ask the Museum')
    expect(widget.launcher()?.getAttribute('aria-label')).toBe('Ask the Museum, opens venue guide')
    widget.launcher()?.click()
    expect(widget.panel()?.style.backgroundColor).toBe('rgb(13, 17, 22)')
    expect(widget.frame()?.style.backgroundColor).toBe('rgb(13, 17, 22)')
  })

  it('mounts an inline venue iframe only after its exact ready handshake', async () => {
    const widget = executeWidget({ slug: null, inlineSlug: 'museum' })
    await Promise.resolve()
    await Promise.resolve()
    const frame = widget.inlineFrame()
    expect(frame?.src).toBe('https://guide.example/embed/museum/inline')
    expect(frame?.hidden).toBe(true)
    expect(frame?.width).toBe('100%')
    expect(frame?.style.minHeight).toBe('min(720px, 85vh)')
    expect(widget.inlineContainer?.dataset.torchikoInlineMounted).toBe('pending')

    dispatchReady(frame!)
    expect(frame?.hidden).toBe(false)
    expect(widget.inlineContainer?.dataset.torchikoInlineMounted).toBe('true')
    runWidgetSource()
    expect(widget.inlineContainer?.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('stays hidden when readiness finishes first and reveals only after CSS loads', async () => {
    const widget = executeWidget({ slug: 'museum' })
    await Promise.resolve()
    await Promise.resolve()

    expect(widget.host?.hidden).toBe(true)
    expect(widget.script.dataset.pathfinderMounted).toBe('pending')
    widget.styles()?.dispatchEvent(new Event('load'))

    expect(widget.host?.hidden).toBe(false)
    expect(widget.script.dataset.pathfinderMounted).toBe('true')
  })

  it('creates one exact sandboxed iframe only after visitor activation', async () => {
    const widget = executeWidget({ slug: 'museum' })
    await completeAvailability(widget)

    widget.launcher()?.click()
    const frame = widget.frame()

    expect(frame?.src).toBe('https://guide.example/embed/museum')
    expect(frame?.title).toBe('Torchiko venue guide')
    expect(frame?.loading).toBe('eager')
    expect(frame?.referrerPolicy).toBe('no-referrer')
    expect(frame?.getAttribute('sandbox')).toBe(
      'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts',
    )
    expect(frame?.getAttribute('allow')).toBe('microphone')
    expect(widget.launcher()?.disabled).toBe(true)
    expect(widget.launcher()?.getAttribute('aria-busy')).toBe('true')
    expect(widget.panel()?.hidden).toBe(true)
  })

  it('accepts only the exact frame origin, source, payload shape, version, and venue', async () => {
    const widget = executeWidget({ slug: 'museum' })
    await completeAvailability(widget)
    widget.launcher()?.click()
    const frame = widget.frame()!

    dispatchReady(frame, {}, { origin: 'https://attacker.example' })
    dispatchReady(frame, {}, { source: window })
    dispatchReady(frame, { venueSlug: 'other' })
    dispatchReady(frame, { version: 2 })
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ...READY_MESSAGE, extra: true },
        origin: 'https://guide.example',
        source: frame.contentWindow,
      }),
    )
    expect(widget.panel()?.hidden).toBe(true)

    dispatchReady(frame)
    expect(widget.panel()?.hidden).toBe(false)
    expect(widget.launcher()?.hidden).toBe(true)
    expect(widget.close()?.getAttribute('aria-label')).toBe('Close Torchiko venue guide')
    expect(widget.shadow?.activeElement).toBe(widget.close())
  })

  it('closes, restores launcher focus, and reopens the same conversation frame', async () => {
    const widget = executeWidget({ slug: 'museum' })
    await completeAvailability(widget)
    widget.launcher()?.click()
    const frame = widget.frame()!
    dispatchReady(frame)

    widget.close()?.click()
    expect(widget.panel()?.hidden).toBe(true)
    expect(widget.launcher()?.hidden).toBe(false)
    expect(widget.launcher()?.getAttribute('aria-expanded')).toBe('false')
    expect(widget.shadow?.activeElement).toBe(widget.launcher())

    widget.launcher()?.click()
    expect(widget.panel()?.hidden).toBe(false)
    expect(widget.frame()).toBe(frame)

    widget
      .close()
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
      )
    expect(widget.panel()?.hidden).toBe(true)
  })

  it('opens through the public API, sends bounded unsent prefill, and emits lifecycle events', async () => {
    const widget = executeWidget({ slug: 'museum', attribute: 'torchiko' })
    const events: string[] = []
    expect(api().version).toBe(1)
    const unsubscribe = api().on('open', () => events.push('open'))
    api().on('ready', () => events.push('ready'))
    api().on('close', () => events.push('close'))
    api().open({ ask: 'Where is the entrance?', place: ' place_1 ' })
    expect(widget.frame()).toBeNull()
    await completeAvailability(widget)
    await vi.waitFor(() => expect(widget.frame()).not.toBeNull())
    const frame = widget.frame()!
    const postMessage = mockGuideWindow(frame)
    dispatchBridge(frame, 'ready')
    expect(widget.panel()?.hidden).toBe(false)
    expect(postMessage).toHaveBeenCalledWith(
      {
        source: 'torchiko',
        v: 1,
        type: 'prefill',
        payload: { ask: 'Where is the entrance?', place: 'place_1' },
      },
      'https://guide.example',
    )
    expect(postMessage).toHaveBeenCalledWith(
      { source: 'torchiko', v: 1, type: 'open', payload: null },
      'https://guide.example',
    )
    expect(events).toEqual(['ready', 'open'])
    api().close()
    expect(widget.panel()?.hidden).toBe(true)
    expect(postMessage).toHaveBeenCalledWith(
      { source: 'torchiko', v: 1, type: 'close', payload: null },
      'https://guide.example',
    )
    expect(events).toEqual(['ready', 'open', 'close'])
    api().open()
    expect(widget.frame()).toBe(frame)
    expect(events).toEqual(['ready', 'open', 'close', 'open'])
    unsubscribe()
    api().close()
    api().open()
    expect(events).toEqual(['ready', 'open', 'close', 'open', 'close'])
  })

  it('ignores spoofed bridge messages and drops invalid API parameters', async () => {
    const widget = executeWidget({ slug: 'museum' })
    await completeAvailability(widget)
    api().open({ ask: 'x'.repeat(201), place: 'bad\nplace' })
    await vi.waitFor(() => expect(widget.frame()).not.toBeNull())
    const frame = widget.frame()!
    const postMessage = mockGuideWindow(frame)
    dispatchBridge(frame, 'ready', { origin: 'https://attacker.example' })
    dispatchBridge(frame, 'ready', { source: null })
    dispatchBridge(frame, 'ready', { payload: { extra: true } })
    expect(widget.panel()?.hidden).toBe(true)
    dispatchBridge(frame, 'ready')
    expect(widget.panel()?.hidden).toBe(false)
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'prefill' }),
      expect.anything(),
    )
    dispatchBridge(frame, 'close-requested', { origin: 'https://attacker.example' })
    expect(widget.panel()?.hidden).toBe(false)
    dispatchBridge(frame, 'close-requested')
    expect(widget.panel()?.hidden).toBe(true)
  })

  it('does not bypass an unavailable venue through the public API', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }))
    const widget = executeWidget({ slug: 'museum' })
    api().open({ ask: 'hello' })
    await completeAvailability(widget)
    expect(widget.host?.isConnected).toBe(false)
    expect(widget.frame()).toBeNull()
  })

  it('accepts bounded height only from the exact inline frame', async () => {
    const widget = executeWidget({ slug: null, inlineSlug: 'museum' })
    const events: string[] = []
    api().on('ready', () => events.push('ready'))
    api().on('open', () => events.push('open'))
    await Promise.resolve()
    await Promise.resolve()
    const frame = widget.inlineFrame()!
    dispatchReady(frame)
    dispatchBridge(frame, 'open')
    dispatchBridge(frame, 'open')
    expect(events).toEqual(['ready', 'open'])
    dispatchBridge(frame, 'height', {
      payload: { height: 900 },
      origin: 'https://attacker.example',
    })
    dispatchBridge(frame, 'height', { payload: { height: 9000 } })
    expect(frame.style.height).toBe('')
    dispatchBridge(frame, 'height', { payload: { height: 900 } })
    expect(frame.style.height).toBe('900px')
    expect(widget.inlineContainer?.style.height).toBe('900px')
  })

  it('contains sequential focus and exposes modal semantics at the full-screen breakpoint', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    const widget = executeWidget({ slug: 'museum' })
    await completeAvailability(widget)
    widget.launcher()?.click()
    const frame = widget.frame()!
    dispatchReady(frame)

    const [startGuard, endGuard] = [...widget.guards()]
    expect(widget.panel()?.getAttribute('aria-modal')).toBe('true')
    startGuard?.focus()
    expect(widget.shadow?.activeElement).toBe(frame)
    endGuard?.focus()
    expect(widget.shadow?.activeElement).toBe(widget.close())
  })

  it('keeps the floating desktop dialog nonmodal and its focus guards out of tab order', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    const widget = executeWidget({ slug: 'museum' })
    await completeAvailability(widget)
    widget.launcher()?.click()
    dispatchReady(widget.frame()!)

    expect(widget.panel()?.hasAttribute('aria-modal')).toBe(false)
    expect([...widget.guards()].map((guard) => guard.tabIndex)).toEqual([-1, -1])
  })

  it('removes the complete widget on preflight, stylesheet, iframe, or readiness failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }))
    const unavailable = executeWidget({ slug: 'museum' })
    await completeAvailability(unavailable)
    expect(unavailable.host?.isConnected).toBe(false)
    expect(unavailable.script.dataset.pathfinderMounted).toBe('failed')

    document.body.replaceChildren()
    const unstyled = executeWidget({ slug: 'museum' })
    unstyled.styles()?.dispatchEvent(new Event('error'))
    await Promise.resolve()
    await Promise.resolve()
    expect(unstyled.host?.isConnected).toBe(false)
    expect(unstyled.script.dataset.pathfinderMounted).toBe('failed')

    document.body.replaceChildren()
    const errored = executeWidget({ slug: 'museum' })
    await completeAvailability(errored)
    errored.launcher()?.click()
    errored.frame()?.dispatchEvent(new Event('error'))
    expect(errored.host?.isConnected).toBe(false)
    expect(errored.script.dataset.pathfinderMounted).toBe('failed')

    document.body.replaceChildren()
    vi.useFakeTimers()
    const timedOut = executeWidget({ slug: 'museum' })
    await completeAvailability(timedOut)
    timedOut.launcher()?.click()
    vi.advanceTimersByTime(10_000)
    expect(timedOut.host?.isConnected).toBe(false)
    expect(timedOut.script.dataset.pathfinderMounted).toBe('failed')
  })

  it('removes the hidden host when the availability probe itself times out', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => undefined))
    const widget = executeWidget({ slug: 'museum' })
    widget.styles()?.dispatchEvent(new Event('load'))

    vi.advanceTimersByTime(10_000)

    expect(widget.host?.isConnected).toBe(false)
    expect(widget.script.dataset.pathfinderMounted).toBe('failed')
  })

  it('loads an isolated viewport-bounded desktop and mobile stylesheet', async () => {
    const widget = executeWidget({ slug: 'museum' })
    await completeAvailability(widget)
    const css = readFileSync(resolve(process.cwd(), 'public/widget.css'), 'utf8')

    expect(css).toContain('min-height: 48px')
    expect(css).toContain('min-height: 44px')
    expect(css).toContain('width: min(420px, calc(100vw - 32px))')
    expect(css).toContain('height: min(720px, calc(100dvh - 112px))')
    expect(css).toContain('@media (max-width: 480px)')
    expect(css).toContain('height: 100dvh')
    expect(css).toContain('z-index: 2147483000')
  })

  it('mounts into the body when the one-line script is installed in the document head', async () => {
    const widget = executeWidget({ slug: 'museum', placement: 'head' })
    await completeAvailability(widget)

    expect(widget.host?.parentElement).toBe(document.body)
    expect(widget.script.parentElement).toBe(document.head)
    expect(widget.host?.hidden).toBe(false)
  })

  it('clears the pre-body timeout after a delayed DOM-ready mount succeeds', async () => {
    vi.useFakeTimers()
    document.body.remove()
    const widget = executeWidget({ slug: 'museum', placement: 'head' })

    expect(widget.script.dataset.pathfinderMounted).toBe('pending')
    expect(document.querySelector('[data-pathfinder-widget]')).toBeNull()

    const body = document.createElement('body')
    document.documentElement.appendChild(body)
    document.dispatchEvent(new Event('DOMContentLoaded'))
    const host = body.querySelector<HTMLDivElement>('[data-pathfinder-widget]')!
    const styles = host.shadowRoot?.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')
    styles?.dispatchEvent(new Event('load'))
    await Promise.resolve()
    await Promise.resolve()

    expect(host.hidden).toBe(false)
    expect(widget.script.dataset.pathfinderMounted).toBe('true')
    vi.advanceTimersByTime(20_000)
    expect(host.isConnected).toBe(true)
    expect(widget.script.dataset.pathfinderMounted).toBe('true')
  })

  it.each([null, '', 'Museum', '../museum', 'museum/extra', 'museum?admin=1', 'a'.repeat(201)])(
    'rejects invalid venue authority without changing the host page: %s',
    (slug) => {
      const widget = executeWidget({ slug })
      expect(widget.host).toBeNull()
      if (slug === null || slug === '') {
        expect(widget.script.dataset.torchikoMounted).toBe('true')
        expect(widget.script.dataset.pathfinderMounted).toBe('true')
      } else {
        expect(widget.script.dataset.pathfinderMounted).toBeUndefined()
      }
    },
  )

  it.each([
    '',
    'https://guide.example/other.js',
    'http://guide.example/widget.js',
    'ftp://guide.example/widget.js',
    'https://user:password@guide.example/widget.js',
  ])('rejects unsafe loader source %s', (source) => {
    expect(executeWidget({ slug: 'museum', source }).host).toBeNull()
  })

  it('permits explicit loopback HTTP development and ignores script query authority', async () => {
    const widget = executeWidget({
      slug: 'museum',
      source: 'http://127.0.0.1:3000/widget.js?target=https://attacker.example',
    })
    await completeAvailability(widget)
    widget.launcher()?.click()
    expect(widget.frame()?.src).toBe('http://127.0.0.1:3000/embed/museum')
  })

  it('mounts at most once for one script element, including pending and failed attempts', async () => {
    const first = executeWidget({ slug: 'museum' })
    runWidgetSource()
    expect(document.querySelectorAll('[data-pathfinder-widget]')).toHaveLength(1)
    await completeAvailability(first)

    document.body.replaceChildren()
    expect(executeWidget({ slug: 'museum', mounted: 'failed' }).host).toBeNull()
  })

  it('mounts async head snippets after their late container is inserted', async () => {
    const widget = executeWidget({
      slug: null,
      inlineSlug: 'museum',
      appendInline: false,
      placement: 'head',
      async: true,
    })
    expect(widget.inlineContainer?.isConnected).toBe(false)
    document.body.appendChild(widget.inlineContainer!)
    await Promise.resolve()
    await Promise.resolve()
    expect(widget.inlineContainer?.dataset.torchikoInlineMounted).toBe('pending')
    expect(widget.inlineFrame()?.src).toBe('https://guide.example/embed/museum/inline')
  })

  it('sizes a zero-height inline container through the iframe only', async () => {
    const widget = executeWidget({ slug: null, inlineSlug: 'museum', inlineHeight: '0px' })
    await Promise.resolve()
    await Promise.resolve()
    expect(widget.inlineContainer?.style.height).toBe('0px')
    expect(widget.inlineFrame()?.style.minHeight).toBe('min(720px, 85vh)')
  })

  it('sizes a mobile modal to the host visual viewport and restores CSS on close', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    )
    const listeners: Record<string, Array<() => void>> = { resize: [], scroll: [] }
    const viewport = {
      offsetTop: 24,
      height: 720,
      addEventListener: vi.fn((type: 'resize' | 'scroll', listener: () => void) => {
        listeners[type]!.push(listener)
      }),
      removeEventListener: vi.fn((type: 'resize' | 'scroll', listener: () => void) => {
        listeners[type] = listeners[type]!.filter((candidate) => candidate !== listener)
      }),
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const widget = executeWidget({ slug: 'museum' })
    await completeAvailability(widget)
    widget.launcher()?.click()
    dispatchReady(widget.frame()!)

    expect(widget.panel()?.style.top).toBe('24px')
    expect(widget.panel()?.style.height).toBe('720px')
    viewport.offsetTop = 168
    viewport.height = 520
    listeners.resize?.forEach((listener) => listener())
    expect(widget.panel()?.style.top).toBe('168px')
    expect(widget.panel()?.style.height).toBe('520px')

    widget.close()?.click()
    expect(widget.panel()?.style.top).toBe('')
    expect(widget.panel()?.style.height).toBe('')
    expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })
})
