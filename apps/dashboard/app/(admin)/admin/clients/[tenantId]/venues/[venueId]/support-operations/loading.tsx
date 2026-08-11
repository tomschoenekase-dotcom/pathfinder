export default function SupportOperationsLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading support operations">
      <div className="h-28 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <div className="grid gap-5 xl:grid-cols-[20rem_1fr]">
        <div className="h-72 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
        <div className="h-96 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      </div>
      <p className="sr-only">Loading support operations…</p>
    </div>
  )
}
