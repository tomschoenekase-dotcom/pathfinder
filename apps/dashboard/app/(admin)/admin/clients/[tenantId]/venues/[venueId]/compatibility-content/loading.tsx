export default function LoadingCompatibilityContent() {
  return (
    <div role="status" className="space-y-4" aria-label="Loading compatibility content">
      <div className="h-32 animate-pulse rounded-2xl bg-pf-surface" />
      <div className="h-64 animate-pulse rounded-2xl bg-pf-surface" />
    </div>
  )
}
