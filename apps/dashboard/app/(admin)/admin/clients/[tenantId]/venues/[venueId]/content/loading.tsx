export default function LoadingUniversalContent() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <p className="text-sm font-medium text-pf-deep">Loading normalized content…</p>
      <div className="h-28 animate-pulse rounded-2xl bg-pf-surface motion-reduce:animate-none" />
      <div className="h-28 animate-pulse rounded-2xl bg-pf-surface motion-reduce:animate-none" />
    </div>
  )
}
