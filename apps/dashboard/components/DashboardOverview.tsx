'use client'

import Link from 'next/link'
import { useOrganization } from '@clerk/nextjs'
import { Bot, Building2, MapPin, Megaphone, Sparkles, Users, type LucideIcon } from 'lucide-react'

type DashboardOverviewProps = {
  stats: {
    activeAlerts: number
    sessionsThisWeek: number
    totalPlaces: number
    venues: number
  }
}

type QuickAction = {
  href: string
  label: string
  description: string
  icon: LucideIcon
}

type StatCard = {
  href: string
  icon: LucideIcon
  iconClassName?: string
  label: string
  valueKey: keyof DashboardOverviewProps['stats']
  description: string
}

function getQuickActions(stats: DashboardOverviewProps['stats']) {
  const actions: QuickAction[] = []

  if (stats.venues === 0) {
    actions.push({
      href: '/venues/new',
      label: 'Create your first venue',
      description: 'Set up a venue to get started.',
      icon: Building2,
    })
  } else if (stats.totalPlaces < 5) {
    actions.push({
      href: '/venues',
      label: 'Add places to your venue',
      description: 'The more places you add, the better the chatbot answers.',
      icon: MapPin,
    })
  } else {
    actions.push({
      href: '/venues/new',
      label: 'Add another venue',
      description: 'Expand your footprint with a new venue.',
      icon: Building2,
    })
  }

  actions.push({
    href: '/operational-updates/new',
    label: 'Publish an alert',
    description: 'Let guests know about closures or changes right now.',
    icon: Megaphone,
  })

  actions.push({
    href: '/ai-controls',
    label: 'Tune the AI guide',
    description: 'Adjust tone, featured places, and guide notes.',
    icon: Bot,
  })

  return actions
}

const statCards: StatCard[] = [
  {
    href: '/venues',
    icon: Building2,
    iconClassName: 'text-slate-400',
    label: 'Venues',
    valueKey: 'venues',
    description: 'Venue records currently active in your workspace.',
  },
  {
    href: '/venues',
    icon: MapPin,
    iconClassName: 'text-slate-400',
    label: 'Total Places',
    valueKey: 'totalPlaces',
    description: 'Points of interest mapped across your venues.',
  },
  {
    href: '/operational-updates',
    icon: Megaphone,
    label: 'Active Alerts',
    valueKey: 'activeAlerts',
    description: 'Closures and redirects currently published to guests.',
  },
  {
    href: '/analytics',
    icon: Users,
    iconClassName: 'text-slate-400',
    label: 'Sessions this week',
    valueKey: 'sessionsThisWeek',
    description: 'Unique guest chat sessions opened in the last 7 days.',
  },
] as const

export function DashboardOverview({ stats }: DashboardOverviewProps) {
  const { organization } = useOrganization()
  const orgName = organization?.name ?? 'Your organization'
  const quickActions = getQuickActions(stats)

  return (
    <div className="min-h-screen px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <section>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{orgName}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
            Monitor guest activity, publish operational alerts, and fine-tune the AI guide for each
            of your venues.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {statCards.map((card) => {
            const Icon = card.icon
            const iconClassName =
              card.valueKey === 'activeAlerts' && stats.activeAlerts > 0
                ? 'text-amber-500'
                : (card.iconClassName ?? 'text-slate-400')

            return (
              <Link
                key={card.label}
                href={card.href}
                className="block rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm transition hover:border-cyan-200 hover:shadow-md"
              >
                <Icon className={`h-5 w-5 ${iconClassName}`} aria-hidden="true" />
                <p className="mt-4 text-sm font-medium text-slate-500">{card.label}</p>
                <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  {stats[card.valueKey]}
                </p>
                <p className="mt-3 text-sm text-slate-600">{card.description}</p>
              </Link>
            )
          })}
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
