'use client'

import { useEffect, useRef, useState } from 'react'

export type NetworkConnectionState = 'online' | 'offline' | 'reconnected'

const RECONNECTED_NOTICE_MS = 5_000

function initialConnectionState(): NetworkConnectionState {
  return typeof navigator === 'undefined' || navigator.onLine ? 'online' : 'offline'
}

export function useNetworkStatus(): NetworkConnectionState {
  const [connectionState, setConnectionState] =
    useState<NetworkConnectionState>(initialConnectionState)
  const reconnectTimerRef = useRef<number | null>(null)

  useEffect(() => {
    function clearReconnectTimer() {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    function handleOffline() {
      clearReconnectTimer()
      setConnectionState('offline')
    }

    function handleOnline() {
      clearReconnectTimer()
      setConnectionState((current) => (current === 'offline' ? 'reconnected' : 'online'))
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        setConnectionState('online')
      }, RECONNECTED_NOTICE_MS)
    }

    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)

    return () => {
      clearReconnectTimer()
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  return connectionState
}
