type LocationBannerProps = {
  permission: 'granted' | 'denied' | 'prompt' | 'loading'
  onRefresh: () => void
}

export function LocationBanner({ permission, onRefresh }: LocationBannerProps) {
  if (permission === 'granted') {
    return null
  }

  if (permission === 'loading') {
    return (
      <section className="mb-4 rounded-3xl border border-pf-light bg-pf-white p-4 text-pf-deep/60 shadow-sm">
        <p className="text-sm font-semibold text-pf-deep">Checking location...</p>
        <p className="mt-1 text-sm leading-6 text-pf-deep/60">
          Waiting for your device to share its position.
        </p>
      </section>
    )
  }

  const content =
    permission === 'denied'
      ? {
          title: 'Location access denied',
          description: 'Enable location in your browser settings to get distance-aware answers.',
          action: 'Try again',
        }
      : {
          title: 'Allow location for better answers',
          description: 'PathFinder uses your position to tell you what is nearby.',
          action: 'Share location',
        }

  return (
    <section className="mb-4 rounded-3xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-pf-deep">{content.title}</p>
          <p className="mt-1 text-sm leading-6 text-pf-deep/60">{content.description}</p>
        </div>
        <button
          className="inline-flex min-h-10 items-center justify-center rounded-full border border-amber-300 bg-pf-white px-4 text-sm font-medium text-amber-700 transition hover:bg-amber-50"
          type="button"
          onClick={onRefresh}
        >
          {content.action}
        </button>
      </div>
    </section>
  )
}
