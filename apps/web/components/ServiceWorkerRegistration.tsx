'use client'

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

export const OFFLINE_SUPPORT_ATTRIBUTE = 'data-pathfinder-offline-support'
export const OFFLINE_SUPPORT_UNAVAILABLE_EVENT = 'pathfinder:offline-support-unavailable'
const OFFLINE_CACHE_PREFIX = 'pathfinder-offline-'

export function ServiceWorkerRegistration({ enabled = true }: { enabled?: boolean }) {
  useEffect(() => {
    const serviceWorker = navigator.serviceWorker

    if (!serviceWorker || typeof serviceWorker.register !== 'function') {
      document.documentElement.setAttribute(OFFLINE_SUPPORT_ATTRIBUTE, 'unsupported')
      return
    }

    let active = true

    const reportUnavailable = (message: string) => {
      if (!active) {
        return
      }

      document.documentElement.setAttribute(OFFLINE_SUPPORT_ATTRIBUTE, 'unavailable')
      window.dispatchEvent(new Event(OFFLINE_SUPPORT_UNAVAILABLE_EVENT))
      try {
        Sentry.captureException(new Error(message))
      } catch {
        // The local diagnostic state must survive a monitoring-client failure.
      }
    }

    const retire = async () => {
      document.documentElement.setAttribute(OFFLINE_SUPPORT_ATTRIBUTE, 'retiring')

      let retirementFailed = false

      try {
        const registration =
          typeof serviceWorker.getRegistration === 'function'
            ? await serviceWorker.getRegistration('/')
            : undefined

        if (registration && !(await registration.unregister())) {
          retirementFailed = true
        }
      } catch {
        retirementFailed = true
      }

      try {
        const cacheStorage = window.caches
        if (cacheStorage) {
          const cacheNames = await cacheStorage.keys()
          await Promise.all(
            cacheNames
              .filter((cacheName) => cacheName.startsWith(OFFLINE_CACHE_PREFIX))
              .map((cacheName) => cacheStorage.delete(cacheName)),
          )
        }
      } catch {
        retirementFailed = true
      }

      if (retirementFailed) {
        reportUnavailable('Torchico offline support retirement failed')
      } else if (active) {
        document.documentElement.setAttribute(OFFLINE_SUPPORT_ATTRIBUTE, 'retired')
      }
    }

    const register = async () => {
      document.documentElement.setAttribute(OFFLINE_SUPPORT_ATTRIBUTE, 'registering')

      try {
        await serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        if (active) {
          document.documentElement.setAttribute(OFFLINE_SUPPORT_ATTRIBUTE, 'registered')
        }
      } catch {
        reportUnavailable('Torchico offline support registration failed')
      }
    }

    if (!enabled) {
      void retire()
    } else if (document.readyState === 'complete') {
      void register()
    } else {
      window.addEventListener('load', register, { once: true })
    }

    return () => {
      active = false
      window.removeEventListener('load', register)
    }
  }, [enabled])

  return null
}
