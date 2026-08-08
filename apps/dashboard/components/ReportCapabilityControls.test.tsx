/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  updateConfiguration: vi.fn(),
  generateReport: vi.fn(),
  publishReport: vi.fn(),
  updateReportDraft: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}))

vi.mock('@clerk/nextjs', () => ({
  SignOutButton: ({ children }: { children: React.ReactNode }) => children,
  useOrganization: () => ({ organization: { name: 'Test Tenant' } }),
  useUser: () => ({ user: { publicMetadata: {} } }),
}))

vi.mock('@pathfinder/ui', () => ({ PathFinderBrand: () => <div>PathFinder</div> }))

vi.mock('../lib/trpc', () => ({
  createTRPCClient: () => ({
    admin: {
      updateVenueReportConfiguration: { mutate: mocks.updateConfiguration },
      generateWeeklyReportDraft: { mutate: mocks.generateReport },
      publishWeeklyReport: { mutate: mocks.publishReport },
      updateWeeklyReportDraft: { mutate: mocks.updateReportDraft },
    },
  }),
}))

import { DashboardShell } from './DashboardShell'
import { AdminGenerateWeeklyReportButton } from './admin/AdminGenerateWeeklyReportButton'
import { AdminVenueReportConfiguration } from './admin/AdminVenueReportConfiguration'
import { WeeklyReportEditor } from './admin/WeeklyReportEditor'

describe('weekly report capability controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('hides the client navigation entry until at least one venue is enabled', () => {
    const { rerender } = render(
      <DashboardShell weeklyReportsEnabled={false}>
        <div>content</div>
      </DashboardShell>,
    )
    expect(screen.queryByText('Weekly Reports')).toBeNull()

    rerender(
      <DashboardShell weeklyReportsEnabled>
        <div>content</div>
      </DashboardShell>,
    )
    expect(screen.getByText('Weekly Reports')).toBeTruthy()
  })

  it('sends an exact configuration revision and refreshes after enabling', async () => {
    mocks.updateConfiguration.mockResolvedValueOnce({ enabled: true })
    render(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled={false}
        updatedAt={null}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable Reports' }))

    await waitFor(() =>
      expect(mocks.updateConfiguration).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: true,
        expectedUpdatedAt: null,
      }),
    )
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('adopts a refreshed server revision after a configuration conflict', async () => {
    mocks.updateConfiguration.mockRejectedValueOnce(new Error('Configuration changed'))
    const { rerender } = render(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled={false}
        updatedAt="2026-08-08T12:00:00.000Z"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable Reports' }))
    await screen.findByText('Configuration changed')

    rerender(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled
        updatedAt="2026-08-08T12:05:00.000Z"
      />,
    )
    mocks.updateConfiguration.mockResolvedValueOnce({
      enabled: false,
      updatedAt: new Date('2026-08-08T12:06:00.000Z'),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Disable Reports' }))

    await waitFor(() =>
      expect(mocks.updateConfiguration).toHaveBeenLastCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: false,
        expectedUpdatedAt: new Date('2026-08-08T12:05:00.000Z'),
      }),
    )
  })

  it('prevents report generation from the admin UI while disabled', () => {
    render(
      <AdminGenerateWeeklyReportButton
        tenantId="tenant_1"
        venueId="venue_1"
        weekStart="2026-08-01T00:00:00.000Z"
        weekEnd="2026-08-07T23:59:59.999Z"
        enabled={false}
      />,
    )

    const button = screen.getByRole('button', { name: 'Enable Reports to Generate' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(mocks.generateReport).not.toHaveBeenCalled()
  })

  it('publishes only the exact report revision shown to the reviewer', async () => {
    mocks.publishReport.mockResolvedValueOnce({ ok: true })
    render(
      <WeeklyReportEditor
        tenantId="tenant_1"
        venueId="venue_1"
        reportId="report_1"
        initialTitle="Report"
        initialContent="Reviewed report body"
        initialUpdatedAt="2026-08-08T12:00:00.000Z"
        status="DRAFT"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Publish to Client Dashboard' }))

    await waitFor(() =>
      expect(mocks.publishReport).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: '2026-08-08T12:00:00.000Z',
      }),
    )
  })
})
