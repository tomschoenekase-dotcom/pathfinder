export default function FreshnessAuditLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading freshness audit">
      <div className="h-36 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <div className="h-64 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <div className="h-64 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <p className="sr-only">Loading freshness audit…</p>
    </div>
  )
}
