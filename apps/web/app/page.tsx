import {
  Binoculars,
  Building2,
  Fish,
  Landmark,
  Leaf,
  MapPinned,
  MessageCircle,
  ScanLine,
  Trophy,
} from 'lucide-react'

const exampleQuestions = [
  "Where's the closest bathroom?",
  "What's good for kids under 5?",
  'How far is the elephant exhibit?',
  'What time does the cafe close?',
  'Is there seating near the entrance?',
  "What's the featured exhibit today?",
]

const venueTypes = [
  { label: 'Zoos & Aquariums', icon: Fish },
  { label: 'Museums & Galleries', icon: Landmark },
  { label: 'Malls & Retail Centers', icon: Building2 },
  { label: 'Sports Venues & Stadiums', icon: Trophy },
  { label: 'Parks & Botanical Gardens', icon: Leaf },
]

export default function WebHomePage() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <section className="relative overflow-hidden bg-slate-950 px-6 py-24 text-white sm:py-32 lg:px-10">
        <div className="absolute left-1/2 top-0 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-cyan-400/20 blur-3xl" />
        <div className="absolute bottom-10 right-8 hidden h-40 w-40 rounded-[3rem] border border-cyan-300/20 bg-white/5 lg:block" />

        <div className="relative mx-auto grid max-w-7xl gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300">
              PathFinder
            </p>
            <h1 className="mt-6 max-w-4xl text-5xl font-semibold tracking-tight sm:text-6xl lg:text-7xl">
              Your venue&apos;s AI guide. Trained on your places.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
              Guests ask questions. PathFinder answers - with directions, hours, and recommendations
              specific to your venue. No generic chatbot. No setup headaches.
            </p>
            <div className="mt-10 flex flex-col gap-4 sm:flex-row">
              <a
                href="mailto:tomschoenekase@gmail.com?subject=PathFinder%20demo%20request"
                className="inline-flex min-h-12 items-center justify-center rounded-full bg-cyan-300 px-6 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
              >
                Request a demo
              </a>
              <a
                href="#demo"
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-white/15 px-6 text-sm font-semibold text-white transition hover:border-cyan-300 hover:text-cyan-200"
              >
                See it in action -&gt;
              </a>
            </div>
          </div>

          <div
            id="demo"
            className="rounded-[2rem] border border-white/10 bg-white/10 p-4 shadow-2xl shadow-cyan-950/40 backdrop-blur"
          >
            <div className="rounded-[1.5rem] bg-slate-950/80 p-5">
              <div className="flex items-center gap-3 border-b border-white/10 pb-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300 text-slate-950">
                  <MessageCircle className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">Guest guide</p>
                  <p className="text-xs text-slate-400">Live from a QR code</p>
                </div>
              </div>
              <div className="mt-5 space-y-4">
                <div className="ml-auto max-w-[82%] rounded-3xl rounded-br-md bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950">
                  What should we see first with two kids?
                </div>
                <div className="max-w-[88%] rounded-3xl rounded-bl-md bg-white px-4 py-3 text-sm leading-6 text-slate-800">
                  Start at River Otters, then follow the east path to the touch pool. It is a
                  4-minute walk and both are open until 5 PM.
                </div>
                <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
                  <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-cyan-100">
                    <MapPinned className="mb-2 h-4 w-4" aria-hidden="true" />
                    Directions-aware
                  </div>
                  <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-cyan-100">
                    <ScanLine className="mb-2 h-4 w-4" aria-hidden="true" />
                    No app download
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-20 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-700">
            How it works
          </p>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {[
              [
                'Add your places',
                "You enter your venue's locations, exhibits, amenities, and hours.",
              ],
              [
                'The AI learns your venue',
                'PathFinder builds a guide that knows your specific layout, not generic directions.',
              ],
              [
                'Guests get instant answers',
                'Via QR code or link, on any phone, no app download required.',
              ],
            ].map(([title, body], index) => (
              <article
                key={title}
                className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-sm font-semibold text-cyan-300">
                  {index + 1}
                </div>
                <h2 className="mt-6 text-xl font-semibold tracking-tight">{title}</h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white px-6 py-20 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-700">
              What guests can ask
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
              Answers that sound like your best floor staff.
            </h2>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {exampleQuestions.map((question, index) => (
              <div
                key={question}
                className={`rounded-[2rem] px-5 py-4 text-sm shadow-sm ${
                  index % 2 === 0
                    ? 'bg-slate-950 text-white'
                    : 'border border-slate-200 bg-slate-50 text-slate-800'
                }`}
              >
                {question}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-20 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-700">
            Who it is for
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {venueTypes.map(({ label, icon: Icon }) => (
              <article
                key={label}
                className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h2 className="mt-5 text-base font-semibold leading-6">{label}</h2>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-slate-950 px-6 py-20 text-white lg:px-10">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 rounded-[2.5rem] border border-cyan-300/20 bg-cyan-300/10 p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <Binoculars className="h-8 w-8 text-cyan-300" aria-hidden="true" />
            <h2 className="mt-5 text-3xl font-semibold tracking-tight">
              Ready to give your guests a smarter experience?
            </h2>
          </div>
          <a
            href="mailto:tomschoenekase@gmail.com?subject=PathFinder%20demo%20request"
            className="inline-flex min-h-12 items-center justify-center rounded-full bg-cyan-300 px-6 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
          >
            Get in touch
          </a>
        </div>
      </section>
    </main>
  )
}
