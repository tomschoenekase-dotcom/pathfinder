/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AdminLoading from '../app/(admin)/admin/loading'
import AdminError from '../app/(admin)/admin/error'
import OperationsLoading from '../app/(admin)/admin/operations/loading'
import ClientPortalLoading from '../app/(app)/loading'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

let pathname = '/admin'

vi.mock('next/navigation', () => ({ usePathname: () => pathname }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('./admin/AdminCommandPalette', () => ({
  AdminCommandPalette: () => <button type="button">Open command palette</button>,
}))
vi.mock('./admin/ViewAsClientButton', () => ({
  ViewAsClientButton: () => <button type="button">Preview client portal</button>,
}))
vi.mock('@clerk/nextjs', () => ({
  SignOutButton: ({ children }: { children: React.ReactNode }) => children,
  useOrganization: () => ({ organization: { name: 'Museum Group' } }),
  useUser: () => ({ user: { publicMetadata: {} } }),
}))

import { resolveClientPortalLifecycle } from '@pathfinder/contracts/client-portal-lifecycle'
import { AdminSectionShell } from './admin/AdminSectionShell'
import { ClientWorkspaceShell } from './admin/ClientWorkspaceShell'
import { DashboardOverview } from './DashboardOverview'
import { DashboardShell } from './DashboardShell'

async function expectNoAutomatedViolations(container: HTMLElement) {
  expect(document.body.contains(container)).toBe(true)
  document.documentElement.lang = 'en'
  document.title = 'Torchiko accessibility contract'
  const result = await axe.run(document, {
    rules: {
      // jsdom has no layout or computed pixel colors. Real-browser contrast remains a separate gate.
      'color-contrast': { enabled: false },
    },
  })
  expect(
    result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
  ).toEqual([])
}

describe('Packet 2 authenticated surface automated accessibility', () => {
  afterEach(() => {
    cleanup()
    pathname = '/admin'
  })

  it('finds no automated violations in the Admin OS shell and loading state', async () => {
    pathname = '/admin/operations'
    const { container } = render(
      <AdminSectionShell>
        <AdminLoading />
      </AdminSectionShell>,
    )
    await expectNoAutomatedViolations(container)
  })

  it('finds no automated violations in the Admin OS error and recovery state', async () => {
    const { container } = render(<AdminError error={new Error('private detail')} reset={vi.fn()} />)
    await expectNoAutomatedViolations(container)
  })

  it('finds no automated violations in an exact-scoped Internal Workspace', async () => {
    pathname = '/admin/clients/client-1/venues/venue-1/content'
    const { container } = render(
      <ClientWorkspaceShell
        client={{ id: 'client-1', name: 'Museum Group', slug: 'museum-group', status: 'ACTIVE' }}
        venues={[
          {
            id: 'venue-1',
            name: 'East Museum',
            slug: 'east-museum',
            isActive: true,
            guestUrl: 'https://guest.example/east-museum',
          },
        ]}
      >
        <OperationsLoading />
      </ClientWorkspaceShell>,
    )
    await expectNoAutomatedViolations(container)
  })

  it('finds no automated violations in the client portal live and loading states', async () => {
    const lifecycle = resolveClientPortalLifecycle({
      isActive: true,
      publicContentCount: 1,
      wasLive: true,
      collectingSourceCount: 0,
      processingSourceCount: 0,
      reviewSourceCount: 0,
      intakeProposalCount: 0,
      packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 },
      hasActiveOffboarding: false,
    })
    pathname = '/'
    const { container } = render(
      <DashboardShell weeklyReportsAvailable>
        <DashboardOverview
          venue={{ id: 'east-museum', name: 'East Museum', lifecycle }}
          venues={[{ id: 'east-museum', name: 'East Museum' }]}
          activeUpdates={1}
          chatUrl="https://guest.example/east-museum"
        />
        <ClientPortalLoading />
      </DashboardShell>,
    )
    await expectNoAutomatedViolations(container)
  })
})
