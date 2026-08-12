'use client'

export default function CompatibilityContentError({ reset }: { reset: () => void }) {
  return (
    <section role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
      <h2 className="text-lg font-semibold text-rose-950">Compatibility content is unavailable</h2>
      <p className="mt-2 text-sm text-rose-900">
        No content was changed. Retry the scoped read when ready.
      </p>
      <button
        onClick={reset}
        className="mt-4 min-h-11 rounded-xl bg-rose-900 px-4 font-semibold text-white"
      >
        Retry
      </button>
    </section>
  )
}
