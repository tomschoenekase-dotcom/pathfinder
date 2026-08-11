export default function AgentRunLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading agent run">
      <div className="h-32 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <div className="h-52 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <p className="sr-only">Loading agent run…</p>
    </div>
  )
}
