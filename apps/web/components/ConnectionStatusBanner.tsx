import type { NetworkConnectionState } from '../hooks/useNetworkStatus'

export function ConnectionStatusBanner({ state }: { state: NetworkConnectionState }) {
  if (state === 'online') return null

  const offline = state === 'offline'

  return (
    <div
      className={`border-b px-4 py-2.5 sm:px-6 ${
        offline
          ? 'border-amber-300 bg-amber-50 text-amber-950'
          : 'border-emerald-300 bg-emerald-50 text-emerald-950'
      }`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="mx-auto max-w-2xl text-sm leading-5">
        <span className="font-semibold">{offline ? "You're offline" : 'Back online'}</span>
        <span className="ml-1">
          {offline
            ? 'Keep typing—your draft stays on this screen. Reconnect before sending.'
            : 'You can send your draft. If a message needs attention, use its retry or check action.'}
        </span>
      </div>
    </div>
  )
}
