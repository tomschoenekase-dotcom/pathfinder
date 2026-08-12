'use client'

export default function GuestDesignError({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="rounded-3xl border border-rose-200 bg-white p-8 shadow-sm" role="alert">
      <h2 className="text-2xl font-semibold text-pf-deep">Guest design is unavailable</h2>
      <p className="mt-2 text-sm text-pf-deep/75">
        No presentation setting was changed. Retry this exact venue workspace.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 min-h-11 rounded-xl border border-pf-light px-5 text-sm font-semibold text-pf-primary"
      >
        Retry Guest design
      </button>
    </section>
  )
}
