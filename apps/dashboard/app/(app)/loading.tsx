export default function ClientPortalLoading() {
  return (
    <div className="min-h-screen px-4 py-6 sm:px-6 sm:py-10 lg:px-10" role="status">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-3">
          <div className="h-4 w-24 animate-pulse rounded bg-pf-light motion-reduce:animate-none" />
          <div className="h-10 w-72 max-w-full animate-pulse rounded-lg bg-pf-light motion-reduce:animate-none" />
        </div>
        <div className="h-72 animate-pulse rounded-[2rem] bg-pf-deep motion-reduce:animate-none" />
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="h-48 animate-pulse rounded-[1.75rem] border border-pf-light bg-white motion-reduce:animate-none"
            />
          ))}
        </div>
        <span className="sr-only">Loading your Torchico portal…</span>
      </div>
    </div>
  )
}
