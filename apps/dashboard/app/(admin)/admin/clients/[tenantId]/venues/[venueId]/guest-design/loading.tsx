export default function GuestDesignLoading() {
  return (
    <section className="rounded-3xl border border-pf-light bg-white p-8 shadow-sm" role="status">
      <p className="text-sm font-semibold text-pf-primary">Loading exact-scoped Guest design…</p>
      <div className="mt-5 h-72 animate-pulse rounded-2xl bg-pf-surface motion-reduce:animate-none" />
    </section>
  )
}
