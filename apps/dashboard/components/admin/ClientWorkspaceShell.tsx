'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { ViewAsClientButton } from './ViewAsClientButton'

type WorkspaceVenue = {
  id: string
  name: string
  slug: string
  isActive: boolean
  guestUrl: string | null
}

type ClientWorkspaceShellProps = {
  children: ReactNode
  client: {
    id: string
    name: string
    slug: string
    status: string
  }
  venues: WorkspaceVenue[]
  billingAvailable?: boolean
}

type NavigationItem = {
  href: string
  label: string
  description: string
  exact?: boolean
}

function WorkspaceLink({ item }: { item: NavigationItem }) {
  const pathname = usePathname()
  const active = item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`)

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`group block rounded-xl border px-3 py-2.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent ${
        active
          ? 'border-pf-primary/20 bg-pf-primary text-white shadow-sm'
          : 'border-transparent text-pf-deep/70 hover:border-pf-light hover:bg-white hover:text-pf-deep'
      }`}
    >
      <span className="block text-sm font-semibold">{item.label}</span>
      <span
        className={`mt-0.5 hidden text-xs leading-4 xl:block ${active ? 'text-white/85' : 'text-pf-deep/70'}`}
      >
        {item.description}
      </span>
    </Link>
  )
}

function NavigationGroup({ label, items }: { label: string; items: NavigationItem[] }) {
  return (
    <div className="min-w-[10rem] space-y-1 lg:min-w-0">
      <p className="px-3 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-pf-deep/70">
        {label}
      </p>
      <div className="space-y-1">
        {items.map((item) => (
          <WorkspaceLink key={item.href} item={item} />
        ))}
      </div>
    </div>
  )
}

export function ClientWorkspaceShell({
  children,
  client,
  venues,
  billingAvailable = false,
}: ClientWorkspaceShellProps) {
  const pathname = usePathname()
  const selectedVenue =
    venues.find((venue) => {
      const venuePath = `/venues/${venue.id}`
      return pathname.includes(`${venuePath}/`) || pathname.endsWith(venuePath)
    }) ?? null
  const clientRoot = `/admin/clients/${client.id}`
  const venueRoot = selectedVenue ? `${clientRoot}/venues/${selectedVenue.id}` : null

  const clientNavigation: NavigationItem[] = [
    {
      href: clientRoot,
      label: 'Client overview',
      description: 'Account health and venues',
      exact: true,
    },
    ...(billingAvailable
      ? [
          {
            href: `${clientRoot}/billing`,
            label: 'Billing',
            description: 'Arrangements, invoices and recovery',
          },
        ]
      : []),
    {
      href: `${clientRoot}/analytics`,
      label: 'Portfolio analytics',
      description: 'Client-wide engagement',
    },
    {
      href: `${clientRoot}/offboarding`,
      label: 'Offboarding',
      description: 'Revocation plan and exports',
    },
    {
      href: `${clientRoot}/credentials`,
      label: 'External credentials',
      description: 'Disabled MCP and partner access',
    },
  ]

  const venueBuildNavigation: NavigationItem[] = venueRoot
    ? [
        {
          href: venueRoot,
          label: 'Venue overview',
          description: 'Status, content and availability',
          exact: true,
        },
        {
          href: `${venueRoot}/content`,
          label: 'Universal content',
          description: 'Typed modules and provenance',
        },
        {
          href: `${venueRoot}/compatibility-content`,
          label: 'Legacy compatibility',
          description: 'Internal Place and Knowledge upkeep',
        },
        {
          href: `${venueRoot}/locations`,
          label: 'Location anchors',
          description: 'Verified guest map and place references',
        },
        {
          href: `${venueRoot}/intake`,
          label: 'Guided intake',
          description: 'Website and staff draft proposals',
        },
        {
          href: `${venueRoot}/deployment-manifest`,
          label: 'Manifest review',
          description: 'Validate v2 package handoff',
        },
        {
          href: `${venueRoot}/packages`,
          label: 'Venue packages',
          description: 'Review immutable package evidence',
        },
        {
          href: `${venueRoot}/native-releases`,
          label: 'Native FULL releases',
          description: 'Review NATIVE_CORE_V1 deployment evidence',
        },
        {
          href: `${venueRoot}/media`,
          label: 'Media intake',
          description: 'Process and review source media',
        },
        {
          href: `${venueRoot}/ai-configuration`,
          label: 'AI configuration',
          description: 'Effective models and safety defaults',
        },
        {
          href: `${venueRoot}/guest-design`,
          label: 'Guest design',
          description: 'Branding and responsive preview',
        },
      ]
    : []
  const venueInsightNavigation: NavigationItem[] = venueRoot
    ? [
        {
          href: `${venueRoot}/chatlogs`,
          label: 'Guest conversations',
          description: 'Review transcripts and flags',
        },
        {
          href: `${venueRoot}/analysis`,
          label: 'Answer analysis',
          description: 'Synthesize visitor responses',
        },
        {
          href: `${venueRoot}/evaluations`,
          label: 'Evaluations',
          description: 'Quality, failures and conclusions',
        },
        {
          href: `${venueRoot}/freshness`,
          label: 'Freshness',
          description: 'Stale sources and metadata gaps',
        },
        {
          href: `${venueRoot}/knowledge-proposals`,
          label: 'Knowledge proposals',
          description: 'Review evidence-backed change suggestions',
        },
        {
          href: `${venueRoot}/agents`,
          label: 'Agent operations',
          description: 'Runs, actions and approvals',
        },
        {
          href: `${venueRoot}/support-operations`,
          label: 'Support',
          description: 'Client requests and internal notes',
        },
        {
          href: `${venueRoot}/reports`,
          label: 'Reports',
          description: 'Prepare client-ready reporting',
        },
      ]
    : []

  return (
    <div className="space-y-5">
      <nav
        aria-label="Breadcrumb"
        className="flex flex-wrap items-center gap-2 text-xs font-medium text-pf-deep/70"
      >
        <Link href="/admin" className="transition hover:text-pf-primary">
          Torchiko OS
        </Link>
        <span aria-hidden="true">/</span>
        <Link href="/admin/directory" className="transition hover:text-pf-primary">
          Directory
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={clientRoot} className="transition hover:text-pf-primary">
          {client.name}
        </Link>
        {selectedVenue ? (
          <>
            <span aria-hidden="true">/</span>
            <span className="text-pf-deep" aria-current="page">
              {selectedVenue.name}
            </span>
          </>
        ) : null}
      </nav>

      <div className="overflow-hidden rounded-3xl border border-pf-light bg-pf-white shadow-sm">
        <header className="border-b border-pf-light bg-[linear-gradient(120deg,rgba(18,74,78,0.06),rgba(255,255,255,0)_65%)] px-5 py-5 sm:px-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-pf-deep px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-[0.15em] text-white">
                  {selectedVenue ? 'Venue scope' : 'Client scope'}
                </span>
                <span className="text-xs font-semibold uppercase tracking-wider text-pf-deep/70">
                  Internal workspace
                </span>
              </div>
              <h1
                id="workspace-title"
                className="mt-2 truncate text-2xl font-semibold tracking-tight text-pf-deep sm:text-3xl"
              >
                {selectedVenue?.name ?? client.name}
              </h1>
              <p className="mt-1 text-sm text-pf-deep/75">
                {selectedVenue
                  ? `${client.name} · ${selectedVenue.slug}`
                  : `Client account · ${client.slug}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ViewAsClientButton
                tenantId={client.id}
                tenantName={client.name}
                label="Preview client portal"
              />
              {selectedVenue?.guestUrl ? (
                <a
                  href={selectedVenue.guestUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-10 items-center rounded-2xl border border-pf-light bg-white px-4 py-2 text-sm font-semibold text-pf-deep transition hover:border-pf-accent hover:text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                >
                  Open guest preview{' '}
                  <span aria-hidden="true" className="ml-1">
                    ↗
                  </span>
                </a>
              ) : null}
            </div>
          </div>
        </header>

        <div className="grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
          <aside
            className="border-b border-pf-light bg-pf-surface/60 p-3 lg:border-b-0 lg:border-r lg:p-4"
            aria-label="Workspace navigation"
          >
            <div className="flex gap-3 overflow-x-auto pb-1 lg:block lg:space-y-5 lg:overflow-visible lg:pb-0">
              <NavigationGroup label="Client" items={clientNavigation} />

              <div className="min-w-[12rem] lg:min-w-0">
                <p className="px-3 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-pf-deep/70">
                  Venues
                </p>
                <div className="mt-1 space-y-1">
                  {venues.map((venue) => {
                    const active = selectedVenue?.id === venue.id
                    return (
                      <Link
                        key={venue.id}
                        href={`${clientRoot}/venues/${venue.id}`}
                        aria-current={active ? 'page' : undefined}
                        className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent ${
                          active
                            ? 'bg-white text-pf-primary shadow-sm ring-1 ring-pf-light'
                            : 'text-pf-deep/75 hover:bg-white hover:text-pf-deep'
                        }`}
                      >
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${venue.isActive ? 'bg-emerald-500' : 'bg-amber-500'}`}
                          aria-hidden="true"
                        />
                        <span className="truncate">{venue.name}</span>
                      </Link>
                    )
                  })}
                  {venues.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-pf-deep/70">No venues yet</p>
                  ) : null}
                </div>
              </div>

              {venueRoot ? (
                <NavigationGroup label="Build & manage" items={venueBuildNavigation} />
              ) : null}
              {venueRoot ? (
                <NavigationGroup label="Observe & improve" items={venueInsightNavigation} />
              ) : null}
            </div>
          </aside>

          <div className="min-w-0 p-5 sm:p-7 lg:p-8">{children}</div>
        </div>
      </div>
    </div>
  )
}
