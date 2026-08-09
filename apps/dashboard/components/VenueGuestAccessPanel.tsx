import { CopyUrlButton } from './CopyUrlButton'

type VenueGuestAccessPanelProps = {
  venueName: string
  guestChatUrl: string | null
  isVenueActive: boolean
  activePlacesCount: number
  guideMode: 'location_aware' | 'non_location'
  hasCompleteCenter: boolean
}

export function VenueGuestAccessPanel({
  venueName,
  guestChatUrl,
  isVenueActive,
  activePlacesCount,
  guideMode,
  hasCompleteCenter,
}: VenueGuestAccessPanelProps) {
  const reviewIssues = [
    ...(!isVenueActive ? ['Venue guest access is paused.'] : []),
    ...(activePlacesCount === 0 ? ['Add an active guide item.'] : []),
    ...(guideMode === 'location_aware' && !hasCompleteCenter
      ? ['Set a complete venue center for location-aware ordering.']
      : []),
  ]

  return (
    <section
      aria-labelledby="guest-access-review-title"
      className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pf-accent">
            Setup review
          </p>
          <h2
            id="guest-access-review-title"
            className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep"
          >
            Guest chat link
          </h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            Review the guest experience and its answers before sharing this link. This checklist is
            not launch approval.
          </p>
        </div>
        <span
          className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ${
            guestChatUrl === null
              ? 'bg-rose-100 text-rose-700'
              : reviewIssues.length > 0
                ? 'bg-amber-100 text-amber-800'
                : 'bg-emerald-100 text-emerald-700'
          }`}
        >
          {guestChatUrl === null
            ? 'Sharing unavailable'
            : reviewIssues.length > 0
              ? 'Preview only'
              : 'Review link available'}
        </span>
      </div>

      {guestChatUrl === null ? (
        <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">
          The public web origin is not configured safely for this environment. Ask an administrator
          to configure it before testing or sharing {venueName}&apos;s guest chat.
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          <p className="break-all rounded-2xl bg-pf-surface px-4 py-3 font-mono text-sm text-pf-deep">
            {guestChatUrl}
          </p>
          {reviewIssues.length > 0 ? (
            <ul className="space-y-1 text-sm text-amber-800">
              {reviewIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-start gap-3">
            <a
              href={guestChatUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
            >
              Open guest chat
            </a>
            <CopyUrlButton url={guestChatUrl} />
          </div>
        </div>
      )}
    </section>
  )
}
