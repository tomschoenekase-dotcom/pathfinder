export default function EvaluationOperationsLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading evaluation evidence">
      <div className="h-28 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <div className="h-72 animate-pulse rounded-3xl bg-pf-surface motion-reduce:animate-none" />
      <p className="sr-only">Loading evaluation evidence…</p>
    </div>
  )
}
