type LocationBannerProps = {
  permission: 'granted' | 'denied' | 'prompt' | 'loading'
  onRefresh: () => void
}

export function LocationBanner({ permission, onRefresh }: LocationBannerProps) {
  if (permission === 'granted') {
    return null
  }

  const content =
    permission === 'denied'
      ? {
          title: 'Location denied',
          description: 'Answers may be less precise until location access is restored.',
          action: 'Try again',
        }
      : permission === 'loading'
        ? {
            title: 'Checking location',
            description: 'PathFinder is preparing live wayfinding for this venue.',
            action: 'Retry',
          }
        : {
            title: 'Allow location for better answers',
            description: 'This helps PathFinder tell you what is nearby in the venue.',
            action: 'Share location',
          }

  return (
    <section className="mb-4 rounded-[1.75rem] border border-amber-300/20 bg-amber-300/10 p-4 text-amber-50 shadow-lg shadow-amber-950/10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">{content.title}</p>
          <p className="mt-1 text-sm leading-6 text-amber-50/80">{content.description}</p>
        </div>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-amber-100/30 px-4 text-sm font-medium text-amber-50 transition hover:bg-amber-50/10"
          type="button"
          onClick={onRefresh}
        >
          {content.action}
        </button>
      </div>
    </section>
  )
}
