export default function AdminAiSystemsLoading() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="ai-systems-loading-heading"
      className="max-w-3xl border-y border-slate-200 py-8"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-800">
        Founder operations
      </p>
      <h1
        id="ai-systems-loading-heading"
        className="mt-2 text-2xl font-semibold tracking-tight text-slate-950"
      >
        Loading AI system status…
      </h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Reading worker policy and visitor-chat routing. No AI route or credential will be changed
        while this view loads.
      </p>
    </section>
  )
}
