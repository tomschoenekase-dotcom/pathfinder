import Link from 'next/link'
import type { ReactNode } from 'react'

export function BotMakerWorkspace({ reviewInbox }: { reviewInbox: ReactNode }) {
  return (
    <div className="space-y-8">
      <section className="overflow-hidden border border-slate-300 bg-white">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="p-5 sm:p-7">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-700">
              Bot Maker · founder gate
            </p>
            <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-slate-950">
              Approve the character before animation work begins
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              Codex prepares an exact first-draft image from the approved reference. You inspect
              that image here. “All good” approves only its appearance and queues the basic
              animation export; it never publishes the character.
            </p>
          </div>
          <aside className="border-t border-amber-200 bg-amber-50 p-5 lg:border-l lg:border-t-0">
            <p className="text-xs font-bold uppercase tracking-wider text-amber-900">
              Preferred creation route
            </p>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              Codex using your ChatGPT account
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-700">
              This review screen makes no model request and spends no visitor-chatbot API budget.
              ChatGPT plan usage and API billing are separate.
            </p>
          </aside>
        </div>
        <ol className="grid border-t border-slate-200 md:grid-cols-3">
          {[
            ['01', 'Draft', 'Codex creates one reviewable appearance from the locked reference.'],
            ['02', 'Your call', 'Choose All good, request a bounded revision, or reject it.'],
            [
              '03',
              'Prepare motion',
              'An approved appearance enters the basic animation/export job.',
            ],
          ].map(([number, title, copy], index) => (
            <li
              key={number}
              className={`p-5 ${index > 0 ? 'border-t border-slate-200 md:border-l md:border-t-0' : ''}`}
            >
              <span className="font-mono text-xs font-bold text-amber-700">{number}</span>
              <p className="mt-2 font-semibold text-slate-950">{title}</p>
              <p className="mt-1 text-sm leading-5 text-slate-600">{copy}</p>
            </li>
          ))}
        </ol>
      </section>

      {reviewInbox}

      <section className="border-l-4 border-slate-300 bg-slate-50 px-5 py-4 text-sm text-slate-700">
        <p className="font-semibold text-slate-950">Current animation boundary</p>
        <p className="mt-1 leading-6">
          The proven first pass supports safe semantic movement and static fallbacks. Fluid flame
          contour deformation is deferred; approving a face or silhouette does not claim that later
          renderer work is complete.{' '}
          <Link className="font-semibold text-sky-800 underline" href="/admin/character-lab">
            Inspect the character runtime lab
          </Link>
          .
        </p>
      </section>
    </div>
  )
}
