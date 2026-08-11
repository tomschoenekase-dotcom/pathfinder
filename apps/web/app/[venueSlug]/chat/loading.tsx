export default function GuestChatLoading() {
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-[var(--chat-bg,#f2f5f9)] p-4"
      role="status"
    >
      <div className="w-full max-w-3xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 animate-pulse rounded-xl bg-slate-200 motion-reduce:animate-none" />
          <div className="space-y-2">
            <div className="h-4 w-40 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
            <div className="h-3 w-24 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
          </div>
        </div>
        <div className="h-[65vh] animate-pulse rounded-3xl border border-slate-200 bg-white motion-reduce:animate-none" />
        <span className="sr-only">Preparing the venue guide…</span>
      </div>
    </main>
  )
}
