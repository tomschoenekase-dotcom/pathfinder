import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const READY_MESSAGE = {
  type: 'pathfinder:embed-ready',
  version: 1,
  venueSlug: 'museum',
}

function runWidgetSource() {
  const source = readFileSync(resolve(process.cwd(), 'public/widget.js'), 'utf8')
  runInNewContext(source, { URL, document, encodeURIComponent, window })
}

function executeWidget(params: {
  slug: string | null
  source?: string
  mounted?: string
  placement?: 'body' | 'head'
}) {
  const script = document.createElement('script')
  if (params.slug !== null) script.setAttribute('data-pathfinder-venue', params.slug)
  if (params.mounted) script.dataset.pathfinderMounted = params.mounted
  script.src = params.source ?? 'https://guide.example/widget.js'
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

describe('classic third-party staging widget launcher', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    document.head.querySelectorAll('script[data-pathfinder-venue]').forEach((node) => node.remove())
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
    vi.unstubAllGlobals()
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      value: null,
    })
  })

  it('reveals an accessible closed launcher only after CSS and venue availability', async () => {
    const widget = executeWidget({ slug: 'museum' })

    expect(widget.host?.hidden).toBe(true)
    expect(widget.script.dataset.pathfinderMounted).toBe('pending')
    expect(fetch).toHaveBeenCalledWith(
      'https://guide.example/api/widget-ready/museum',
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
    expect(widget.launcher()?.textContent).toBe('Ask Torchico')
    expect(widget.launcher()?.type).toBe('button')
    expect(widget.launcher()?.getAttribute('aria-expanded')).toBe('false')
    expect(widget.launcher()?.getAttribute('aria-label')).toBe('Open Torchico venue guide')
    expect(widget.panel()?.hidden).toBe(true)
    expect(widget.frame()).toBeNull()
    expect(widget.script.dataset.pathfinderMounted).toBe('true')
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
    expect(frame?.title).toBe('Torchico venue guide')
    expect(frame?.loading).toBe('eager')
    expect(frame?.referrerPolicy).toBe('no-referrer')
    expect(frame?.getAttribute('sandbox')).toBe(
      'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts',
    )
    expect(frame?.hasAttribute('allow')).toBe(false)
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
    expect(widget.close()?.getAttribute('aria-label')).toBe('Close Torchico venue guide')
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
      expect(widget.script.dataset.pathfinderMounted).toBeUndefined()
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
})
