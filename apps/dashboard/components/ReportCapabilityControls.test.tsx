/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  pathname: '/',
  refresh: vi.fn(),
  push: vi.fn(),
  updateConfiguration: vi.fn(),
  getConfiguration: vi.fn(),
  generateReport: vi.fn(),
  publishReport: vi.fn(),
  updateReportDraft: vi.fn(),
  getReport: vi.fn(),
  getAttempt: vi.fn(),
  clearAttempt: vi.fn(),
  isPlatformAdmin: false,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}))

vi.mock('@clerk/nextjs', () => ({
  SignOutButton: ({ children }: { children: React.ReactNode }) => children,
  useOrganization: () => ({ organization: { name: 'Test Tenant' } }),
  useUser: () => ({
    user: {
      publicMetadata: mocks.isPlatformAdmin ? { platform_role: 'PLATFORM_ADMIN' } : {},
    },
  }),
}))

vi.mock('@pathfinder/ui', () => ({ TorchikoBrand: () => <div>Torchiko</div> }))

vi.mock('../lib/generation-request-idempotency', () => ({
  getOrCreateGenerationRequestAttempt: mocks.getAttempt,
  clearGenerationRequestAttempt: mocks.clearAttempt,
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      getVenueReportConfiguration: { query: mocks.getConfiguration },
      updateVenueReportConfiguration: { mutate: mocks.updateConfiguration },
      generateWeeklyReportDraft: { mutate: mocks.generateReport },
      getWeeklyReport: { query: mocks.getReport },
      publishWeeklyReport: { mutate: mocks.publishReport },
      updateWeeklyReportDraft: { mutate: mocks.updateReportDraft },
    },
  }),
}))

import { DashboardShell } from './DashboardShell'
import { AdminGenerateWeeklyReportButton } from './admin/AdminGenerateWeeklyReportButton'
import { AdminVenueReportConfiguration } from './admin/AdminVenueReportConfiguration'
import { WeeklyReportEditor } from './admin/WeeklyReportEditor'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code } })
}

const requestAttempt = {
  fingerprint: 'a'.repeat(64),
  requestId: '11111111-1111-4111-8111-111111111111',
}

describe('weekly report capability controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pathname = '/'
    mocks.isPlatformAdmin = false
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.getAttempt.mockResolvedValue(requestAttempt)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps reports and analytics out of the ultra-simple client navigation', () => {
    render(
      <DashboardShell>
        <div>content</div>
      </DashboardShell>,
    )
    expect(screen.queryByText('Reports')).toBeNull()
    expect(screen.queryByText('Analytics')).toBeNull()
    expect(screen.getByText('Updates')).toBeTruthy()
  })

  it('shows reports only when enabled and marks report descendants active in responsive navigation', () => {
    mocks.pathname = '/weekly-reports/report-1'
    render(
      <DashboardShell weeklyReportsAvailable>
        <div>content</div>
      </DashboardShell>,
    )

    const reportLinks = screen.getAllByRole('link', { name: 'Reports' })
    expect(reportLinks).toHaveLength(1)
    expect(reportLinks.every((link) => link.getAttribute('href') === '/weekly-reports')).toBe(true)
    expect(reportLinks.every((link) => link.getAttribute('aria-current') === 'page')).toBe(true)
    expect(screen.queryByText('Analytics')).toBeNull()
  })

  it('gives platform admins a direct, obvious route into the admin console', () => {
    mocks.isPlatformAdmin = true
    render(
      <DashboardShell>
        <div>content</div>
      </DashboardShell>,
    )

    expect(screen.getByRole('link', { name: 'Admin console' }).getAttribute('href')).toBe('/admin')
    expect(screen.getByRole('button', { name: 'Open admin console' })).toBeTruthy()
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
    expect(await screen.findByText('Current state: Enabled')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect((await screen.findByRole('status')).textContent).toContain('updated')
  })

  it('adopts a refreshed server revision after a configuration conflict', async () => {
    mocks.updateConfiguration.mockRejectedValueOnce(
      codedError('CONFLICT', 'A deliberately opaque production conflict.'),
    )
    const { rerender } = render(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled={false}
        updatedAt="2026-08-08T12:00:00.000Z"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable Reports' }))
    expect((await screen.findByRole('alert')).textContent).toContain('changed after')

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

  it('binds a failed-report retry seed into a fresh idempotency scope', async () => {
    mocks.generateReport.mockRejectedValueOnce(new Error('transport unavailable'))
    render(
      <AdminGenerateWeeklyReportButton
        tenantId="tenant_1"
        venueId="venue_1"
        weekStart="2026-08-01T00:00:00.000Z"
        weekEnd="2026-08-07T23:59:59.999Z"
        enabled
        retrySeed="failed-report:report_1"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Generate Report Draft' }))
    await screen.findByRole('alert')
    expect(mocks.getAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ retrySeed: 'failed-report:report_1' }),
      null,
    )
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

  it.each(['GENERATING', 'FAILED'] as const)(
    'locks report editing and publication while status is %s',
    (status) => {
      render(
        <WeeklyReportEditor
          tenantId="tenant_1"
          venueId="venue_1"
          reportId="report_1"
          initialTitle="Report"
          initialContent="Body"
          initialUpdatedAt="2026-08-08T12:00:00.000Z"
          status={status}
        />,
      )

      expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).disabled).toBe(
        true,
      )
      expect(
        (screen.getByRole('textbox', { name: 'Report content' }) as HTMLTextAreaElement).disabled,
      ).toBe(true)
      expect(
        (screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(
        (screen.getByRole('button', { name: 'Publish to Client Dashboard' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true)
      expect(screen.getByRole('status')).toBeTruthy()
    },
  )

  it('admits one same-tick configuration command and truthfully unlocks after success', async () => {
    const pending = deferred<{ enabled: boolean; updatedAt: Date }>()
    mocks.updateConfiguration.mockReturnValueOnce(pending.promise)
    render(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled={false}
        updatedAt={null}
      />,
    )
    const enable = screen.getByRole('button', { name: 'Enable Reports' })

    act(() => {
      enable.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      enable.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.updateConfiguration).toHaveBeenCalledOnce()
    const section = screen.getByRole('heading', { name: 'Client report access' }).closest('section')
    expect(section?.getAttribute('aria-busy')).toBe('true')
    expect((screen.getByRole('button', { name: /Saving/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    pending.resolve({
      enabled: true,
      updatedAt: new Date('2026-08-08T12:01:00.000Z'),
    })
    expect((await screen.findByRole('status')).textContent).toContain('updated')
    expect(screen.getByText('Current state: Enabled')).toBeTruthy()
    expect(section?.getAttribute('aria-busy')).toBe('false')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('treats conflict-looking configuration message text as an unconfirmed generic outcome', async () => {
    mocks.updateConfiguration.mockRejectedValueOnce(
      new Error('Configuration changed in another session, according to message text.'),
    )
    render(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled={false}
        updatedAt="2026-08-08T12:00:00.000Z"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enable Reports' }))

    expect((await screen.findByRole('alert')).textContent).toContain('could not be confirmed')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('reconciles an uncertain configuration through an explicit authoritative reload', async () => {
    mocks.updateConfiguration.mockRejectedValueOnce(new Error('transport unavailable'))
    mocks.getConfiguration.mockResolvedValueOnce({
      enabled: true,
      updatedAt: new Date('2026-08-08T12:05:00.000Z'),
    })
    render(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled={false}
        updatedAt="2026-08-08T12:00:00.000Z"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable Reports' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reload configuration' }))

    expect(await screen.findByText('Report availability reloaded.')).toBeTruthy()
    expect(mocks.getConfiguration).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(screen.getByText('Current state: Enabled')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Disable Reports' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('bounds authoritative report-configuration reload and keeps changes locked after timeout', async () => {
    mocks.updateConfiguration.mockRejectedValueOnce(new Error('transport unavailable'))
    render(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled={false}
        updatedAt="2026-08-08T12:00:00.000Z"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enable Reports' }))
    const reload = await screen.findByRole('button', { name: 'Reload configuration' })
    vi.useFakeTimers()
    mocks.getConfiguration.mockImplementation(() => new Promise(() => {}))
    fireEvent.click(reload)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const signal = mocks.getConfiguration.mock.calls[0]?.[1]?.signal as AbortSignal
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('could not be reloaded in time')
    expect(
      (screen.getByRole('button', { name: 'Enable Reports' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Reload configuration' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('invalidates an old configuration completion immediately when tenant and venue scope change', async () => {
    const pending = deferred<{ enabled: boolean; updatedAt: Date }>()
    mocks.updateConfiguration.mockReturnValueOnce(pending.promise)
    const view = render(
      <AdminVenueReportConfiguration
        tenantId="tenant_1"
        venueId="venue_1"
        enabled={false}
        updatedAt="2026-08-08T12:00:00.000Z"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enable Reports' }))
    await waitFor(() => expect(mocks.updateConfiguration).toHaveBeenCalledOnce())

    view.rerender(
      <AdminVenueReportConfiguration
        tenantId="tenant_2"
        venueId="venue_2"
        enabled={false}
        updatedAt="2026-08-08T12:10:00.000Z"
      />,
    )
    pending.resolve({ enabled: true, updatedAt: new Date('2026-08-08T12:11:00.000Z') })
    await act(async () => pending.promise)
    expect(screen.getByText('Current state: Disabled')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('captures one immutable generation request, locks title, and navigates exactly once', async () => {
    const pending = deferred<{ reportId: string }>()
    mocks.generateReport.mockReturnValueOnce(pending.promise)
    render(
      <AdminGenerateWeeklyReportButton
        tenantId="tenant_1"
        venueId="venue_1"
        weekStart="2026-08-01T00:00:00.000Z"
        weekEnd="2026-08-07T23:59:59.999Z"
        enabled
      />,
    )
    const title = screen.getByLabelText('Title (optional)') as HTMLInputElement
    fireEvent.change(title, { target: { value: '  Immutable weekly title  ' } })
    const generate = screen.getByRole('button', { name: 'Generate Report Draft' })

    act(() => {
      generate.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      generate.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => expect(mocks.generateReport).toHaveBeenCalledOnce())
    expect(mocks.getAttempt).toHaveBeenCalledWith(
      {
        kind: 'weekly-report',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        rangeStart: '2026-08-01T00:00:00.000Z',
        rangeEnd: '2026-08-07T23:59:59.999Z',
        title: 'Immutable weekly title',
      },
      null,
    )
    expect(mocks.generateReport).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      weekStart: '2026-08-01T00:00:00.000Z',
      weekEnd: '2026-08-07T23:59:59.999Z',
      requestId: requestAttempt.requestId,
      title: 'Immutable weekly title',
    })
    const control = title.closest('div[aria-busy]')
    expect(control?.getAttribute('aria-busy')).toBe('true')
    expect(title.disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Queuing/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    pending.resolve({ reportId: 'report_1' })
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        '/admin/clients/tenant_1/venues/venue_1/reports/report_1',
      ),
    )
    expect(mocks.push).toHaveBeenCalledOnce()
    expect(mocks.clearAttempt).toHaveBeenCalledOnce()
  })

  it.each([
    {
      error: codedError('CONFLICT', 'Opaque generation conflict.'),
      expected: 'conflicts with',
    },
    {
      error: new Error('Generation changed in another session, but only in message text.'),
      expected: 'could not be confirmed',
    },
  ])(
    'uses safe generation failure copy and editing clears it: $expected',
    async ({ error, expected }) => {
      mocks.generateReport.mockRejectedValueOnce(error)
      render(
        <AdminGenerateWeeklyReportButton
          tenantId="tenant_1"
          venueId="venue_1"
          weekStart="2026-08-01T00:00:00.000Z"
          weekEnd="2026-08-07T23:59:59.999Z"
          enabled
        />,
      )
      const title = screen.getByLabelText('Title (optional)')
      fireEvent.change(title, { target: { value: 'First title' } })
      fireEvent.click(screen.getByRole('button', { name: 'Generate Report Draft' }))
      expect((await screen.findByRole('alert')).textContent).toContain(expected)
      expect(mocks.push).not.toHaveBeenCalled()

      fireEvent.change(title, { target: { value: 'Edited title' } })
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it('reconciles an uncertain draft save through an explicit authoritative reload', async () => {
    mocks.updateReportDraft.mockRejectedValueOnce(new Error('transport unavailable'))
    mocks.getReport.mockResolvedValueOnce({
      title: 'Authoritative title',
      content: 'Authoritative body',
      updatedAt: new Date('2026-08-08T12:05:00.000Z'),
      status: 'DRAFT',
    })
    render(
      <WeeklyReportEditor
        tenantId="tenant_1"
        venueId="venue_1"
        reportId="report_1"
        initialTitle="Report"
        initialContent="Body"
        initialUpdatedAt="2026-08-08T12:00:00.000Z"
        status="DRAFT"
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Unconfirmed title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reload report' }))

    expect(await screen.findByText('Report reloaded.')).toBeTruthy()
    expect(mocks.getReport).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
      },
      { signal: expect.any(AbortSignal) },
    )
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(
      'Authoritative title',
    )
    expect(
      (screen.getByRole('textbox', { name: 'Report content' }) as HTMLTextAreaElement).value,
    ).toBe('Authoritative body')
    expect(
      (screen.getByRole('button', { name: 'Publish to Client Dashboard' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('bounds authoritative report reload while preserving the unconfirmed draft', async () => {
    mocks.updateReportDraft.mockRejectedValueOnce(new Error('transport unavailable'))
    render(
      <WeeklyReportEditor
        tenantId="tenant_1"
        venueId="venue_1"
        reportId="report_1"
        initialTitle="Report"
        initialContent="Body"
        initialUpdatedAt="2026-08-08T12:00:00.000Z"
        status="DRAFT"
      />,
    )
    const title = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Unconfirmed title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    const reload = await screen.findByRole('button', { name: 'Reload report' })
    vi.useFakeTimers()
    mocks.getReport.mockImplementation(() => new Promise(() => {}))
    fireEvent.click(reload)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    const signal = mocks.getReport.mock.calls[0]?.[1]?.signal as AbortSignal
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('could not be reloaded in time')
    expect(title.value).toBe('Unconfirmed title')
    expect(title.disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Reload report' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('suppresses late generation navigation after scope change and after unmount', async () => {
    const staleScope = deferred<{ reportId: string }>()
    const afterUnmount = deferred<{ reportId: string }>()
    mocks.generateReport
      .mockReturnValueOnce(staleScope.promise)
      .mockReturnValueOnce(afterUnmount.promise)
    const view = render(
      <AdminGenerateWeeklyReportButton
        tenantId="tenant_1"
        venueId="venue_1"
        weekStart="2026-08-01T00:00:00.000Z"
        weekEnd="2026-08-07T23:59:59.999Z"
        enabled
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Generate Report Draft' }))
    await waitFor(() => expect(mocks.generateReport).toHaveBeenCalledOnce())
    view.rerender(
      <AdminGenerateWeeklyReportButton
        tenantId="tenant_2"
        venueId="venue_2"
        weekStart="2026-08-08T00:00:00.000Z"
        weekEnd="2026-08-14T23:59:59.999Z"
        enabled
      />,
    )
    staleScope.resolve({ reportId: 'stale-report' })
    await act(async () => staleScope.promise)
    expect(mocks.push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Generate Report Draft' }))
    await waitFor(() => expect(mocks.generateReport).toHaveBeenCalledTimes(2))
    view.unmount()
    afterUnmount.resolve({ reportId: 'late-report' })
    await act(async () => afterUnmount.promise)
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('serializes draft saves, locks editor inputs, and adopts the exact returned revision', async () => {
    const pending = deferred<{ updatedAt: string }>()
    mocks.updateReportDraft.mockReturnValueOnce(pending.promise)
    render(
      <WeeklyReportEditor
        tenantId="tenant_1"
        venueId="venue_1"
        reportId="report_1"
        initialTitle="Report"
        initialContent="Initial body"
        initialUpdatedAt="2026-08-08T12:00:00.000Z"
        status="DRAFT"
      />,
    )
    const title = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement
    const content = screen.getByRole('textbox', { name: 'Report content' }) as HTMLTextAreaElement
    fireEvent.change(title, { target: { value: 'Exact saved title' } })
    fireEvent.change(content, { target: { value: 'Exact saved body' } })
    const save = screen.getByRole('button', { name: 'Save Draft' })

    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => expect(mocks.updateReportDraft).toHaveBeenCalledOnce())
    expect(mocks.updateReportDraft).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      reportId: 'report_1',
      title: 'Exact saved title',
      content: 'Exact saved body',
      expectedUpdatedAt: '2026-08-08T12:00:00.000Z',
    })
    const editor = title.closest('div[aria-busy]')
    expect(editor?.getAttribute('aria-busy')).toBe('true')
    expect(title.disabled).toBe(true)
    expect(content.disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Saving/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByRole('button', { name: 'Publish to Client Dashboard' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)

    pending.resolve({ updatedAt: '2026-08-08T12:05:00.000Z' })
    expect(await screen.findByText('Draft saved.')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()

    mocks.updateReportDraft.mockResolvedValueOnce({ updatedAt: '2026-08-08T12:06:00.000Z' })
    fireEvent.change(content, { target: { value: 'Second exact saved body' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    await waitFor(() =>
      expect(mocks.updateReportDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedUpdatedAt: '2026-08-08T12:05:00.000Z' }),
      ),
    )
  })

  it('confirms publish once, fences same-tick overlap, and truthfully completes publication', async () => {
    const pending = deferred<{ ok: boolean }>()
    mocks.publishReport.mockReturnValueOnce(pending.promise)
    render(
      <WeeklyReportEditor
        tenantId="tenant_1"
        venueId="venue_1"
        reportId="report_1"
        initialTitle="Report"
        initialContent="Reviewed body"
        initialUpdatedAt="2026-08-08T12:00:00.000Z"
        status="DRAFT"
      />,
    )
    const publish = screen.getByRole('button', { name: 'Publish to Client Dashboard' })

    act(() => {
      publish.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      publish.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.confirm).toHaveBeenCalledOnce()
    expect(mocks.publishReport).toHaveBeenCalledOnce()
    expect(mocks.publishReport).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      reportId: 'report_1',
      expectedUpdatedAt: '2026-08-08T12:00:00.000Z',
    })
    pending.resolve({ ok: true })
    expect((await screen.findByRole('status')).textContent).toContain('Report published')
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.publishReport).toHaveBeenCalledOnce()
  })

  it.each([
    {
      error: codedError('CONFLICT', 'Opaque weekly report conflict.'),
      expected: 'changed after',
    },
    {
      error: new Error('Weekly report changed, but only in message text.'),
      expected: 'could not be confirmed',
    },
  ])(
    'uses safe editor failure copy and locks all mutations behind reload: $expected',
    async ({ error, expected }) => {
      mocks.updateReportDraft.mockRejectedValueOnce(error)
      render(
        <WeeklyReportEditor
          tenantId="tenant_1"
          venueId="venue_1"
          reportId="report_1"
          initialTitle="Report"
          initialContent="Body"
          initialUpdatedAt="2026-08-08T12:00:00.000Z"
          status="DRAFT"
        />,
      )
      fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
        target: { value: 'Edited draft before failure' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
      expect((await screen.findByRole('alert')).textContent).toContain(expected)
      expect(mocks.refresh).toHaveBeenCalledOnce()
      expect(screen.getByRole('button', { name: 'Reload report' })).toBeTruthy()
      expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).disabled).toBe(
        true,
      )
      expect(
        (screen.getByRole('textbox', { name: 'Report content' }) as HTMLTextAreaElement).disabled,
      ).toBe(true)
      expect(
        (screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(
        (screen.getByRole('button', { name: 'Publish to Client Dashboard' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true)
    },
  )

  it('ignores an old editor completion after report scope change and after unmount', async () => {
    const oldScope = deferred<{ updatedAt: string }>()
    const late = deferred<{ updatedAt: string }>()
    mocks.updateReportDraft.mockReturnValueOnce(oldScope.promise).mockReturnValueOnce(late.promise)
    const view = render(
      <WeeklyReportEditor
        tenantId="tenant_1"
        venueId="venue_1"
        reportId="report_1"
        initialTitle="Old report"
        initialContent="Old body"
        initialUpdatedAt="2026-08-08T12:00:00.000Z"
        status="DRAFT"
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Old report edited' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    await waitFor(() => expect(mocks.updateReportDraft).toHaveBeenCalledOnce())
    view.rerender(
      <WeeklyReportEditor
        tenantId="tenant_2"
        venueId="venue_2"
        reportId="report_2"
        initialTitle="New report"
        initialContent="New body"
        initialUpdatedAt="2026-08-08T13:00:00.000Z"
        status="DRAFT"
      />,
    )
    oldScope.resolve({ updatedAt: '2026-08-08T12:05:00.000Z' })
    await act(async () => oldScope.promise)
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(
      'New report',
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Report content' }), {
      target: { value: 'New body edited' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    await waitFor(() => expect(mocks.updateReportDraft).toHaveBeenCalledTimes(2))
    view.unmount()
    late.resolve({ updatedAt: '2026-08-08T13:05:00.000Z' })
    await act(async () => late.promise)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('releases the publish fence after cancellation so a later save can proceed', async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    mocks.updateReportDraft.mockResolvedValueOnce({ updatedAt: '2026-08-08T12:01:00.000Z' })
    render(
      <WeeklyReportEditor
        tenantId="tenant_1"
        venueId="venue_1"
        reportId="report_1"
        initialTitle="Report"
        initialContent="Body"
        initialUpdatedAt="2026-08-08T12:00:00.000Z"
        status="DRAFT"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Publish to Client Dashboard' }))
    expect(mocks.publishReport).not.toHaveBeenCalled()
    expect(
      screen
        .getByRole('textbox', { name: 'Title' })
        .closest('div[aria-busy]')
        ?.getAttribute('aria-busy'),
    ).toBe('false')

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Edited after cancel' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))
    expect(await screen.findByText('Draft saved.')).toBeTruthy()
    expect(mocks.updateReportDraft).toHaveBeenCalledOnce()
  })
})
