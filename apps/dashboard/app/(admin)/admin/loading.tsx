export default function AdminLoading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading PathFinder operations">
      <div className="space-y-3 border-b border-slate-200 pb-7">
        <div className="h-3 w-28 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
        <div className="h-10 w-full max-w-lg animate-pulse rounded-lg bg-slate-200 motion-reduce:animate-none" />
        <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white motion-reduce:animate-none" />
        <div className="h-72 animate-pulse rounded-2xl bg-slate-900 motion-reduce:animate-none" />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="h-52 animate-pulse rounded-2xl border border-slate-200 bg-white motion-reduce:animate-none xl:col-span-2" />
        <div className="h-52 animate-pulse rounded-2xl border border-slate-200 bg-white motion-reduce:animate-none" />
      </div>
      <span className="sr-only">Loading PathFinder operations…</span>
    </div>
  )
}
