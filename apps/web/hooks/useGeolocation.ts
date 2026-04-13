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

export function useGeolocation(): GeolocationState {
  const [lat, setLat] = useState<number | null>(null)
  const [lng, setLng] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<PermissionState>('loading')
  const watchIdRef = useRef<number | null>(null)

  function clearWatcher() {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
  }

  function startWatch() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setPermission('denied')
      setError('Geolocation is not supported on this device.')
      return
    }

    // Browsers gate geolocation behind secure contexts, so local HTTP testing can
    // behave differently from deployed HTTPS builds.
    setPermission('loading')
    setError(null)
    clearWatcher()

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        setLat(position.coords.latitude)
        setLng(position.coords.longitude)
        setPermission('granted')
        setError(null)
      },
      (positionError) => {
        if (positionError.code === positionError.PERMISSION_DENIED) {
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

    async function readPermission() {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
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

        setPermission(result.state)
      } catch {
        if (active) {
          setPermission('prompt')
        }
      }
    }

    void readPermission()

    return () => {
      active = false
      clearWatcher()
    }
  }, [])

  return {
    lat,
    lng,
    error,
    permission,
    refresh: startWatch,
  }
}
