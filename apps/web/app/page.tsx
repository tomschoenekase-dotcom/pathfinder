export default function WebHomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="max-w-xl space-y-4 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">PathFinder</p>
        <h1 className="text-4xl font-semibold tracking-tight">Venue chat starts from a venue link.</h1>
        <p className="text-base leading-7 text-slate-300">
          Open a QR code or a direct venue URL to launch the public wayfinding assistant.
        </p>
      </div>
    </main>
  )
}
