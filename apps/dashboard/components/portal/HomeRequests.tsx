import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

import { PortalSection, portalButtonSecondary, portalFocus } from './PortalPrimitives'

export type HomeRequest = {
  id: string
  title: string
  /** What Torchiko needs, or where the work stands. */
  detail: string | null
  /** True only when the venue is the one who has to act. */
  needsYou: boolean
  meta: string | null
  href: string
  actionLabel: string
}

export function HomeRequests({ requests }: { requests: HomeRequest[] }) {
  const needsYou = requests.filter((request) => request.needsYou).length
  return (
    <PortalSection
      id="requests-heading"
      title="Open requests"
      titleAside={
        needsYou ? (
          <span
            className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-tk-ember-text px-1.5 text-xs font-bold text-white"
            aria-label={`${needsYou} waiting for you`}
          >
            {needsYou}
          </span>
        ) : null
      }
      description={requests.length ? 'Things we need from you, and what we’re working on.' : null}
    >
      {requests.length === 0 ? (
        <p className="mt-2 text-sm text-tk-soft">Nothing open with Torchiko right now.</p>
      ) : (
        <ul className="mt-3 divide-y divide-tk-rule rounded-lg border border-tk-rule bg-white">
          {requests.map((request) => {
            const titleId = `request-${request.id}-title`
            return (
              <li key={request.id} className="flex items-start gap-3 px-3.5 py-3">
                <span
                  aria-hidden="true"
                  className={`mt-[0.45rem] h-2.5 w-2.5 shrink-0 rounded-full ${
                    request.needsYou ? 'bg-tk-ember' : 'border-2 border-tk-rule-strong bg-white'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p id={titleId} className="break-words text-[0.95rem] font-semibold leading-6">
                    {request.title}
                    <span className="sr-only">
                      {request.needsYou ? ' (waiting for you)' : ' (Torchiko is working on it)'}
                    </span>
                  </p>
                  {request.detail ? (
                    <p className="mt-0.5 break-words text-sm leading-6 text-tk-ink/85">
                      {request.detail}
                    </p>
                  ) : null}
                  {request.meta ? (
                    <p className="mt-0.5 text-[0.8rem] leading-5 text-tk-soft">{request.meta}</p>
                  ) : null}
                  {request.needsYou ? (
                    <Link
                      href={request.href}
                      aria-describedby={titleId}
                      className={`${portalButtonSecondary} mt-2.5 min-h-10`}
                    >
                      {request.actionLabel}
                    </Link>
                  ) : null}
                </div>
                {!request.needsYou ? (
                  <Link
                    href={request.href}
                    aria-describedby={titleId}
                    className={`-mr-1.5 flex h-11 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-sm font-semibold text-tk-focus hover:bg-tk-ink-wash ${portalFocus}`}
                  >
                    {request.actionLabel}
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </PortalSection>
  )
}
