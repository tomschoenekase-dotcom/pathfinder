'use client'

import { useEffect, useRef, useState } from 'react'

type PermissionState = 'granted' | 'denied' | 'prompt' | 'loading'

type GeolocationState = {
  lat: number | null
  lng: number | null
  error: string | null
  permission: PermissionState
  refresh: () => void
}

const WATCH_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 30_000,
} as const

export function useGeolocation(enabled = true): GeolocationState {
  const [lat, setLat] = useState<number | null>(null)
  const [lng, setLng] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<PermissionState>('loading')
  const watchIdRef = useRef<number | null>(null)
  const watchGenerationRef = useRef(0)

  function clearWatcher() {
    watchGenerationRef.current += 1
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
  }

  function startWatch() {
    clearWatcher()
    const watchGeneration = watchGenerationRef.current

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLat(null)
      setLng(null)
      setPermission('denied')
      setError('Geolocation is not supported on this device.')
      return
    }

    // Browsers gate geolocation behind secure contexts, so local HTTP testing can
    // behave differently from deployed HTTPS builds.
    setPermission('loading')
    setError(null)
    setLat(null)
    setLng(null)

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        if (watchGenerationRef.current !== watchGeneration) return

        setLat(position.coords.latitude)
        setLng(position.coords.longitude)
        setPermission('granted')
        setError(null)
      },
      (positionError) => {
        if (watchGenerationRef.current !== watchGeneration) return

        setLat(null)
        setLng(null)
        if (positionError.code === positionError.PERMISSION_DENIED) {
          clearWatcher()
          setPermission('denied')
          setError('Location permission was denied.')
          return
        }

        setPermission('prompt')
        setError('Location is temporarily unavailable.')
      },
      WATCH_OPTIONS,
    )
  }

  useEffect(() => {
    let active = true

    if (!enabled) {
      clearWatcher()
      setLat(null)
      setLng(null)
      setError(null)
      setPermission('prompt')
      return () => {
        active = false
        clearWatcher()
      }
    }

    async function readPermission() {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        setLat(null)
        setLng(null)
        setPermission('denied')
        setError('Geolocation is not supported on this device.')
        return
      }

      if (!navigator.permissions?.query) {
        setPermission('prompt')
        return
      }

      try {
        const result = await navigator.permissions.query({ name: 'geolocation' })

        if (!active) {
          return
        }

        if (result.state === 'granted') {
          startWatch()
          return
        }

        setLat(null)
        setLng(null)
        setPermission(result.state)
      } catch {
        if (active) {
          setLat(null)
          setLng(null)
          setPermission('prompt')
        }
      }
    }

    void readPermission()

    return () => {
      active = false
      clearWatcher()
    }
  }, [enabled])

  return {
    lat,
    lng,
    error,
    permission,
    refresh: () => {
      if (enabled) startWatch()
    },
  }
}
