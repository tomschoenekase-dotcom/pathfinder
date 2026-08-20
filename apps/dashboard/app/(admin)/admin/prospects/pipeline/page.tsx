import Link from 'next/link'
import { ArrowLeft, CalendarClock, Columns3 } from 'lucide-react'

import { createAdminCaller } from '../../../../../lib/admin-caller'

export const dynamic = 'force-dynamic'

const STAGES = [
  'DISCOVERED',
  'RESEARCHED',
  'NEEDS_REVIEW',
  'READY_FOR_OUTREACH',
  'CONTACTED',
  'FOLLOW_UP_DUE',
  'REPLIED',
  'CONVERSATION',
  'QUALIFIED',
  'PROPOSAL_DECISION',
  'WON',
  'LOST',
  'PARKED',
  'DO_NOT_CONTACT',
] as const

function label(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export default async function ProspectPipelinePage() {
  const caller = await createAdminCaller()
  const pipeline = await caller.admin.getProspectPipeline()
  const now = Date.now()

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/prospects"
          className="inline-flex items-center gap-2 text-sm font-semibold text-sky-700 hover:text-sky-900"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Prospect directory
        </Link>
        <div className="mt-4 flex items-center gap-3">
          <span className="rounded-xl bg-sky-100 p-2.5 text-sky-700">
            <Columns3 className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950">
              Pipeline continuity
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              A stage-oriented operating view with next-action evidence—not a drag-and-drop board.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {STAGES.map((stage) => {
          const items = pipeline.items.filter((item) => item.stage === stage)
          if (!items.length) return null
          return (
            <section
              key={stage}
              className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
              aria-labelledby={`stage-${stage}`}
            >
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-3">
                <h2 id={`stage-${stage}`} className="font-semibold text-slate-900">
                  {label(stage)}
                </h2>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-slate-600 shadow-sm">
                  {items.length}
                </span>
              </div>
              <div className="grid gap-px bg-slate-100 md:grid-cols-2 xl:grid-cols-3">
                {items.map((item) => {
                  const overdue = item.nextActionAt && new Date(item.nextActionAt).getTime() < now
                  return (
                    <Link
                      key={item.id}
                      href={`/admin/prospects/${item.organization.id}`}
                      className="bg-white p-5 transition hover:bg-sky-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate font-semibold text-slate-950">
                            {item.organization.canonicalName}
                          </h3>
                          <p className="mt-1 truncate text-xs text-slate-500">
                            {item.organization.territory?.name ?? 'Unassigned'}
                            {item.organization.venues[0]?.city
                              ? ` · ${item.organization.venues[0].city}`
                              : ''}
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${item.priority === 'URGENT' ? 'bg-rose-100 text-rose-800' : item.priority === 'HIGH' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}
                        >
                          {item.priority}
                        </span>
                      </div>
                      <div
                        className={`mt-4 flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${overdue ? 'bg-rose-50 text-rose-800' : 'bg-slate-50 text-slate-600'}`}
                      >
                        <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          {item.nextAction ?? 'No next action'}
                          {item.nextActionAt
                            ? ` · ${new Date(item.nextActionAt).toLocaleDateString()}`
                            : ''}
                        </span>
                      </div>
                    </Link>
                  )
                })}
              </div>
            </section>
          )
        })}
        {!pipeline.items.length ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
            <p className="font-semibold text-slate-900">No active opportunities</p>
            <p className="mt-1 text-sm text-slate-500">
              Import or create a prospect to begin the pipeline.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
