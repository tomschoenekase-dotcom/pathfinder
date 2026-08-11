export default function AgentOperationsLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading agent operations">
      <div className="h-28 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <div className="h-64 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <div className="h-64 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <p className="sr-only">Loading agent operations…</p>
    </div>
  )
}
