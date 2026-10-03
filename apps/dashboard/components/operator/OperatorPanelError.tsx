import Link from 'next/link'

import {
  OPERATOR_PANEL_FAILURE_COPY,
  type OperatorPanelFailureCategory,
} from '../../lib/operator-panel'

/**
 * Honest failure state for one operator section. It never reads as "nothing here": it says the
 * section could not load, why in coarse terms, and that the other sections are unaffected.
 * Retry is a plain link, so it works without client JavaScript and re-runs the server read.
 */
export function OperatorPanelError({
  section,
  category,
  retryHref,
}: {
  section: string
  category: OperatorPanelFailureCategory
  retryHref: string
}) {
  return (
    <section
      role="alert"
      aria-labelledby="operator-panel-error"
      className="rounded-xl border border-rose-300 bg-rose-50 p-6"
    >
      <h2 id="operator-panel-error" className="text-lg font-semibold text-rose-950">
        The {section} section could not load
      </h2>
      <p className="mt-1 max-w-prose text-sm text-rose-900">
        {OPERATOR_PANEL_FAILURE_COPY[category]} This is not an empty list: nothing was changed, and
        the other sections are current.
      </p>
      <p className="mt-1 text-xs text-rose-900">Reason: {category.replaceAll('_', ' ')}</p>
      <Link
        href={retryHref}
        prefetch={false}
        className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        Try loading again
      </Link>
    </section>
  )
}
