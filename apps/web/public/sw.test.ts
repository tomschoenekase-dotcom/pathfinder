import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WorkerEvent = {
  waitUntil?: (promise: Promise<unknown>) => void
  respondWith?: (promise: Promise<Response>) => void
  request?: unknown
}

describe('offline service worker lifecycle', () => {
  const handlers = new Map<string, (event: WorkerEvent) => void>()
  const add = vi.fn()
  const match = vi.fn()
  const open = vi.fn(() => Promise.resolve({ add, match }))
  const keys = vi.fn()
  const remove = vi.fn()
  const claim = vi.fn(() => Promise.resolve())
  const skipWaiting = vi.fn()
  const fetchRequest = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    add.mockResolvedValue(undefined)
    keys.mockResolvedValue([])
    remove.mockResolvedValue(true)
    skipWaiting.mockResolvedValue(undefined)
    fetchRequest.mockResolvedValue(new Response('network'))

    const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8')
    runInNewContext(source, {
      URL,
      Request,
      Response,
      caches: { open, keys, delete: remove },
      fetch: fetchRequest,
      self: {
        location: { origin: 'https://guide.example.com' },
        clients: { claim },
        skipWaiting,
        addEventListener: (name: string, handler: (event: WorkerEvent) => void) => {
          handlers.set(name, handler)
        },
      },
    })
  })

  it('installs only the reloadable static fallback and skips waiting', async () => {
    let finishSkipWaiting: (() => void) | undefined
    skipWaiting.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSkipWaiting = resolve
        }),
    )
    let completion: Promise<unknown> | undefined
    handlers.get('install')?.({
      waitUntil: (promise) => {
        completion = promise
      },
    })
    let completed = false
    void completion?.then(() => {
      completed = true
    })
    await Promise.resolve()

    expect(open).toHaveBeenCalledWith('pathfinder-offline-v2')
    expect(add).toHaveBeenCalledOnce()
    const request = add.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('https://guide.example.com/offline.html')
    expect(request.cache).toBe('reload')
    expect(skipWaiting).toHaveBeenCalledOnce()
    expect(completed).toBe(false)
    finishSkipWaiting?.()
    await completion
    expect(completed).toBe(true)
  })

  it('deletes only older Torchiko offline caches before claiming clients', async () => {
    keys.mockResolvedValueOnce([
      'pathfinder-offline-v1',
      'pathfinder-offline-v2',
      'another-app-cache',
    ])
    let completion: Promise<unknown> | undefined
    handlers.get('activate')?.({
      waitUntil: (promise) => {
        completion = promise
      },
    })
    await completion

    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('pathfinder-offline-v1')
    expect(claim).toHaveBeenCalledOnce()
  })

  it('uses the network for same-origin GET navigations', async () => {
    const request = {
      method: 'GET',
      mode: 'navigate',
      url: 'https://guide.example.com/museum/chat',
    }
    let response: Promise<Response> | undefined
    handlers.get('fetch')?.({
      request,
      respondWith: (promise) => {
        response = promise
      },
    })

    expect((await response)?.status).toBe(200)
    expect(fetchRequest).toHaveBeenCalledWith(request)
    expect(open).not.toHaveBeenCalled()
  })

  it('serves the static fallback only after a same-origin navigation network failure', async () => {
    const offline = new Response('offline')
    fetchRequest.mockRejectedValueOnce(new TypeError('network unavailable'))
    match.mockResolvedValueOnce(offline)
    const request = {
      method: 'GET',
      mode: 'navigate',
      url: 'https://guide.example.com/museum/chat',
    }
    let response: Promise<Response> | undefined
    handlers.get('fetch')?.({
      request,
      respondWith: (promise) => {
        response = promise
      },
    })

    expect(await response).toBe(offline)
    expect(open).toHaveBeenCalledWith('pathfinder-offline-v2')
    const fallbackRequest = match.mock.calls[0]?.[0] as Request
    expect(fallbackRequest.url).toBe('https://guide.example.com/offline.html')
  })

  it('returns a network error if both navigation and fallback fail', async () => {
    fetchRequest.mockRejectedValueOnce(new TypeError('network unavailable'))
    match.mockRejectedValueOnce(new Error('cache unavailable'))
    const request = { method: 'GET', mode: 'navigate', url: 'https://guide.example.com/' }
    let response: Promise<Response> | undefined
    handlers.get('fetch')?.({
      request,
      respondWith: (promise) => {
        response = promise
      },
    })

    expect((await response)?.type).toBe('error')
  })

  it.each([
    { method: 'POST', mode: 'navigate', url: 'https://guide.example.com/museum/chat' },
    { method: 'GET', mode: 'cors', url: 'https://guide.example.com/api/trpc/chat.send' },
    { method: 'GET', mode: 'navigate', url: 'https://external.example/museum' },
  ])('does not intercept non-navigation, non-GET, or cross-origin traffic %#', (request) => {
    const respondWith = vi.fn()
    handlers.get('fetch')?.({ request, respondWith })

    expect(respondWith).not.toHaveBeenCalled()
    expect(fetchRequest).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps the static fallback free of executable inline script', () => {
    const offlinePage = readFileSync(resolve(process.cwd(), 'public/offline.html'), 'utf8')

    expect(offlinePage).not.toMatch(/<script|onclick=/i)
    expect(offlinePage).toContain('<a class="retry" href="">Reload</a>')
  })
})
