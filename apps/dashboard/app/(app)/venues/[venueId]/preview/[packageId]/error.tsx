'use client'

export default function ClientPreviewError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen px-4 py-10">
      <section
        className="mx-auto max-w-2xl rounded-[2rem] border border-rose-200 bg-white p-8 text-center"
        role="alert"
      >
        <h1 className="text-2xl font-semibold text-pf-deep">The preview could not be opened</h1>
        <p className="mt-3 text-sm text-pf-deep/70">
          Try again. No visitor content was changed or published.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 min-h-11 rounded-full bg-pf-primary px-5 text-sm font-semibold text-white"
        >
          Try again
        </button>
      </section>
    </div>
  )
}
