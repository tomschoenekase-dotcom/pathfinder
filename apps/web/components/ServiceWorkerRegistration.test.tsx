/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ captureException: vi.fn() }))
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }))

import {
  OFFLINE_SUPPORT_ATTRIBUTE,
  OFFLINE_SUPPORT_UNAVAILABLE_EVENT,
  ServiceWorkerRegistration,
} from './ServiceWorkerRegistration'

describe('ServiceWorkerRegistration', () => {
  const register = vi.fn()
  const getRegistration = vi.fn()
  const unregister = vi.fn()
  const cacheKeys = vi.fn()
  const deleteCache = vi.fn()
  const originalReadyState = Object.getOwnPropertyDescriptor(document, 'readyState')

  function setReadyState(value: DocumentReadyState) {
    Object.defineProperty(document, 'readyState', { configurable: true, value })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.removeAttribute(OFFLINE_SUPPORT_ATTRIBUTE)
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration, register },
    })
    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: { delete: deleteCache, keys: cacheKeys },
    })
    getRegistration.mockResolvedValue(undefined)
    unregister.mockResolvedValue(true)
    cacheKeys.mockResolvedValue([])
    deleteCache.mockResolvedValue(true)
  })

  afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute(OFFLINE_SUPPORT_ATTRIBUTE)
    if (originalReadyState) {
      Object.defineProperty(document, 'readyState', originalReadyState)
    }
  })

  it('registers the root worker after an already-complete document loads', async () => {
    setReadyState('complete')
    register.mockResolvedValueOnce({})

    render(<ServiceWorkerRegistration />)

    await waitFor(() => expect(register).toHaveBeenCalledOnce())
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' })
    expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).toBe('registered')
  })

  it('waits for load and removes the pending listener on unmount', () => {
    setReadyState('loading')
    register.mockResolvedValue({})
    const { unmount } = render(<ServiceWorkerRegistration />)

    expect(register).not.toHaveBeenCalled()
    unmount()
    fireEvent(window, new Event('load'))
    expect(register).not.toHaveBeenCalled()
  })

  it('records unsupported browsers without attempting registration', () => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined })

    render(<ServiceWorkerRegistration />)

    expect(register).not.toHaveBeenCalled()
    expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).toBe('unsupported')
  })

  it('exposes a detail-free diagnostic event when registration fails', async () => {
    setReadyState('complete')
    register.mockRejectedValueOnce(new Error('private browser detail'))
    const unavailable = vi.fn()
    window.addEventListener(OFFLINE_SUPPORT_UNAVAILABLE_EVENT, unavailable, { once: true })

    render(<ServiceWorkerRegistration />)

    await waitFor(() =>
      expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).toBe('unavailable'),
    )
    expect(unavailable).toHaveBeenCalledOnce()
    expect(unavailable.mock.calls[0]?.[0]).toBeInstanceOf(Event)
    expect(unavailable.mock.calls[0]?.[0]).not.toBeInstanceOf(CustomEvent)
    expect(mocks.captureException).toHaveBeenCalledOnce()
    const captured = mocks.captureException.mock.calls[0]?.[0]
    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toBe('Torchiko offline support registration failed')
  })

  it('ignores a late registration result after unmount', async () => {
    setReadyState('complete')
    let resolveRegistration: (() => void) | undefined
    register.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRegistration = resolve
        }),
    )
    const { unmount } = render(<ServiceWorkerRegistration />)
    expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).toBe('registering')

    unmount()
    resolveRegistration?.()
    await Promise.resolve()

    expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).toBe('registering')
  })

  it('retires only the root registration and owned offline caches when disabled', async () => {
    getRegistration.mockResolvedValueOnce({ unregister })
    cacheKeys.mockResolvedValueOnce([
      'pathfinder-offline-v1',
      'pathfinder-offline-v2',
      'another-app-cache',
    ])

    render(<ServiceWorkerRegistration enabled={false} />)

    await waitFor(() =>
      expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).toBe('retired'),
    )
    expect(register).not.toHaveBeenCalled()
    expect(getRegistration).toHaveBeenCalledWith('/')
    expect(unregister).toHaveBeenCalledOnce()
    expect(deleteCache.mock.calls.map(([name]) => name)).toEqual([
      'pathfinder-offline-v1',
      'pathfinder-offline-v2',
    ])
    expect(unregister.mock.invocationCallOrder[0]).toBeLessThan(
      cacheKeys.mock.invocationCallOrder[0]!,
    )
  })

  it.each([
    ['cache enumeration', () => cacheKeys.mockRejectedValueOnce(new Error('cache unavailable'))],
    [
      'cache deletion',
      () => {
        cacheKeys.mockResolvedValueOnce(['pathfinder-offline-v2'])
        deleteCache.mockRejectedValueOnce(new Error('delete unavailable'))
      },
    ],
  ])('still unregisters and reports unavailable when %s fails', async (_label, failCleanup) => {
    getRegistration.mockResolvedValueOnce({ unregister })
    failCleanup()

    render(<ServiceWorkerRegistration enabled={false} />)

    await waitFor(() =>
      expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).toBe('unavailable'),
    )
    expect(unregister).toHaveBeenCalledOnce()
    expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).not.toBe('retired')
  })

  it.each([
    ['returns false', () => unregister.mockResolvedValueOnce(false)],
    ['rejects', () => unregister.mockRejectedValueOnce(new Error('unregister unavailable'))],
  ])(
    'still cleans owned caches and reports unavailable when unregister %s',
    async (_label, fail) => {
      getRegistration.mockResolvedValueOnce({ unregister })
      cacheKeys.mockResolvedValueOnce(['pathfinder-offline-v2', 'another-app-cache'])
      fail()

      render(<ServiceWorkerRegistration enabled={false} />)

      await waitFor(() =>
        expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).toBe(
          'unavailable',
        ),
      )
      expect(cacheKeys).toHaveBeenCalledOnce()
      expect(deleteCache).toHaveBeenCalledWith('pathfinder-offline-v2')
      expect(deleteCache).not.toHaveBeenCalledWith('another-app-cache')
      expect(document.documentElement.getAttribute(OFFLINE_SUPPORT_ATTRIBUTE)).not.toBe('retired')
    },
  )
})
