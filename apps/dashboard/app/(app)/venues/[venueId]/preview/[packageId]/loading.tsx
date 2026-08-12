export default function ClientPreviewLoading() {
  return (
    <div className="min-h-screen px-4 py-10" role="status">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="h-12 w-56 animate-pulse rounded-xl bg-pf-light motion-reduce:animate-none" />
        <div className="h-80 animate-pulse rounded-[2rem] bg-pf-deep motion-reduce:animate-none" />
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="h-64 animate-pulse rounded-[1.75rem] bg-pf-light motion-reduce:animate-none"
            />
          ))}
        </div>
        <span className="sr-only">Loading approved visitor preview...</span>
      </div>
    </div>
  )
}
