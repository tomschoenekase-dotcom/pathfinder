export default function AgentRoutinesLoading() {
  return (
    <section aria-busy="true" className="space-y-6">
      <div className="h-28 motion-safe:animate-pulse border-b border-pf-light bg-pf-surface/40" />
      <div className="h-36 motion-safe:animate-pulse border border-pf-light bg-white" />
      <div className="h-64 motion-safe:animate-pulse border border-pf-light bg-white" />
    </section>
  )
}
