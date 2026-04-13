import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="max-w-md space-y-4 rounded-3xl border border-white/10 bg-white/5 p-8 text-center shadow-2xl shadow-cyan-950/20">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">404</p>
        <h1 className="text-3xl font-semibold tracking-tight">Venue not found</h1>
        <p className="text-sm leading-6 text-slate-300">
          Check the venue link and try again. This public app only serves active venues.
        </p>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-cyan-400/40 px-5 text-sm font-medium text-cyan-100 transition hover:border-cyan-300 hover:bg-cyan-400/10"
        >
          Back to PathFinder
        </Link>
      </div>
    </main>
  )
}
