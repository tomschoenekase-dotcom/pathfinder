'use client'

import Link from 'next/link'
import { useOrganization } from '@clerk/nextjs'
import { Bot, Building2, Megaphone, Sparkles } from 'lucide-react'

type DashboardOverviewProps = {
  stats: {
    activeAlerts: number
    sessionsThisWeek: number
    totalPlaces: number
    venues: number
  }
}

const quickActions = [
  {
    href: '/venues/new',
    label: 'Add a Venue',
    description: 'Create a new venue and start loading places for guests.',
    icon: Building2,
  },
  {
    href: '/operational-updates/new',
    label: 'Create Operational Alert',
    description: 'Publish closures or real-time guidance for guests.',
    icon: Megaphone,
  },
  {
    href: '/ai-controls',
    label: 'Manage AI Controls',
    description: 'Adjust promotions, restrictions, and venue guidance rules.',
    icon: Bot,
  },
] as const

export function DashboardOverview({ stats }: DashboardOverviewProps) {
  const { organization } = useOrganization()
  const orgName = organization?.name ?? 'Your organization'

  return (
    <div className="min-h-screen px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <section className="rounded-[2rem] bg-slate-950 px-8 py-10 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">
            Overview
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">{orgName}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            Monitor your venue footprint, keep place content current, and prepare for analytics and
            operational tooling as they come online.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Venues</p>
            <p className="mt-4 text-4xl font-semibold tracking-tight text-slate-950">
              {stats.venues}
            </p>
            <p className="mt-3 text-sm text-slate-600">
              Venue records currently active in your workspace.
            </p>
          </article>

          <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Total Places</p>
            <p className="mt-4 text-4xl font-semibold tracking-tight text-slate-950">
              {stats.totalPlaces}
            </p>
            <p className="mt-3 text-sm text-slate-600">
              Points of interest mapped across your venues.
            </p>
          </article>

          <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Active Alerts</p>
            <p className="mt-4 text-4xl font-semibold tracking-tight text-slate-950">
              {stats.activeAlerts}
            </p>
            <p className="mt-3 text-sm text-slate-600">
              Closures and redirects currently published to guests.
            </p>
          </article>

          <article className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-slate-500">Sessions this week</p>
            <p className="mt-4 text-4xl font-semibold tracking-tight text-slate-950">
              {stats.sessionsThisWeek}
            </p>
            <p className="mt-3 text-sm text-slate-600">
              Unique guest chat sessions opened in the last 7 days.
            </p>
          </article>
        </section>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <Sparkles className="h-5 w-5 text-cyan-700" aria-hidden="true" />
            <div>
              <h2 className="text-xl font-semibold text-slate-950">Quick Actions</h2>
              <p className="text-sm text-slate-600">
                Jump into the next setup steps for your tenant workspace.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            {quickActions.map((action) => {
              const Icon = action.icon

              return (
                <Link
                  key={action.href}
                  href={action.href}
                  className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-5 transition hover:border-cyan-200 hover:bg-cyan-50"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-cyan-700 shadow-sm">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-5 text-lg font-semibold text-slate-950">{action.label}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{action.description}</p>
                </Link>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
