/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveClientPortalLifecycle } from '@pathfinder/contracts/client-portal-lifecycle'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@clerk/nextjs', () => ({
  useOrganization: () => ({ organization: { name: 'Riverside Museum' } }),
}))
import { DashboardOverview } from './DashboardOverview'

const lifecycle = (state: 'LIVE' | 'PROCESSING' | 'SETUP_REQUESTED' = 'LIVE') => {
  const base = {
    isActive: false,
    publicContentCount: 0,
    wasLive: false,
    collectingSourceCount: 0,
    processingSourceCount: 0,
    reviewSourceCount: 0,
    intakeProposalCount: 0,
    packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
    hasActiveOffboarding: false,
  }
  if (state === 'LIVE')
    return resolveClientPortalLifecycle({ ...base, isActive: true, publicContentCount: 1 })
  if (state === 'PROCESSING')
    return resolveClientPortalLifecycle({ ...base, processingSourceCount: 1 })
  return resolveClientPortalLifecycle(base)
}

const lifecycleFrom = (overrides: Partial<Parameters<typeof resolveClientPortalLifecycle>[0]>) =>
  resolveClientPortalLifecycle({
    isActive: false,
    publicContentCount: 0,
    wasLive: false,
    collectingSourceCount: 0,
    processingSourceCount: 0,
    reviewSourceCount: 0,
    intakeProposalCount: 0,
    packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
    hasActiveOffboarding: false,
    ...overrides,
  })

describe('DashboardOverview client portal', () => {
  afterEach(cleanup)

  it('centers live status and primary client actions without analytics or venue hierarchy', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle() }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={1}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0)
    expect(
      screen
        .getAllByRole('link', { name: /Open visitor guide/ })
        .every((link) => link.getAttribute('href') === 'https://guest.example/riverside'),
    ).toBe(true)
    expect(screen.getByText(/1 visitor update live/)).toBeTruthy()
    expect(screen.getByText('Visitor experience')).toBeTruthy()
    expect(screen.getByText('Help & changes')).toBeTruthy()
    expect(screen.queryByText(/analytics/i)).toBeNull()
    expect(screen.queryByText(/sessions/i)).toBeNull()
    expect(screen.queryByText(/1 venue/i)).toBeNull()
    expect(screen.getByRole('link', { name: 'Open QR code' }).getAttribute('href')).toBe(
      '/venues/riverside/qr-kit',
    )
  })

  it('offers QR materials when ready and withholds them while paused', () => {
    const { rerender } = render(
      <DashboardOverview
        venue={{
          id: 'venue / one',
          name: 'Riverside',
          lifecycle: lifecycleFrom({
            publicContentCount: 1,
            packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 },
          }),
        }}
        venues={[{ id: 'venue / one', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.getByRole('link', { name: 'Open QR code' }).getAttribute('href')).toBe(
      '/venues/venue%20%2F%20one/qr-kit',
    )

    rerender(
      <DashboardOverview
        venue={{
          id: 'venue / one',
          name: 'Riverside',
          lifecycle: lifecycleFrom({ wasLive: true }),
        }}
        venues={[{ id: 'venue / one', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.queryByRole('link', { name: 'Open QR code' })).toBeNull()
  })

  it('keeps a completed live venue out of onboarding mode', () => {
    render(
      <DashboardOverview
        venue={{ id: 'space-museum', name: 'SpaceMuseum', lifecycle: lifecycle() }}
        venues={[{ id: 'space-museum', name: 'SpaceMuseum' }]}
        activeUpdates={0}
        chatUrl="https://guide.example.com/museumroom/chat"
        tasks={[]}
      />,
    )

    expect(screen.getByRole('link', { name: /Open visitor guide/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open QR code' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/start|continue setup|onboarding|begin setup/iu)
  })

  it('shows a privacy-bounded visitor pulse and routes changes into a service request', () => {
    render(
      <DashboardOverview
        venue={{ id: 'venue / one', name: 'Riverside', lifecycle: lifecycle() }}
        venues={[{ id: 'venue / one', name: 'Riverside' }]}
        activeUpdates={0}
        visitorPulse={{
          windowDays: 30,
          conversationCount: 18,
          feedback: { helpful: 9, notHelpful: 2 },
        }}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Last 30 days with visitors' })).toBeTruthy()
    expect(screen.getByText('18')).toBeTruthy()
    expect(screen.getByText('9')).toBeTruthy()
    expect(
      screen.getByText(
        /does not expose visitor identities, locations, or conversation transcripts/i,
      ),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Ask for a review' }).getAttribute('href')).toBe(
      '/support?venue=venue%20%2F%20one&new=visitor-insight',
    )
  })

  it('renders an honest visitor pulse empty state without inventing activity', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle() }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        visitorPulse={{
          windowDays: 30,
          conversationCount: 0,
          feedback: { helpful: 0, notHelpful: 0 },
        }}
      />,
    )

    expect(screen.getByText(/summary will appear here as visitors use Torchiko/i)).toBeTruthy()
    expect(screen.queryByText('0')).toBeNull()
  })

  it('withholds stale preview and distinguishes a ready public visitor link', () => {
    const previewLifecycle = lifecycleFrom({
      packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
    })
    const { rerender } = render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: previewLifecycle,
          clientPreview: { state: 'SUPERSEDED', id: null },
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.getByText(/updated preview is being prepared/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /open preview|visitor experience/i })).toBeNull()

    rerender(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({
            publicContentCount: 1,
            packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 },
          }),
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(
      screen
        .getAllByRole('link', { name: /Open visitor guide/ })
        .every((link) => link.getAttribute('href') === 'https://guest.example/riverside'),
    ).toBe(true)
  })

  it('never falls back to public guest content when client preview is unavailable', () => {
    render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({
            packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
          }),
          clientPreview: { state: 'UNAVAILABLE', id: null },
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
      />,
    )
    expect(screen.getByText(/preview is temporarily unavailable/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /open preview|visitor experience/i })).toBeNull()
  })

  it('explains the onboarding state without making clients configure the system', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle('PROCESSING') }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
      />,
    )
    expect(screen.getByText('In progress')).toBeTruthy()
    expect(screen.getByText('Nothing you need to do right now.')).toBeTruthy()
    expect(screen.getByText('We’re preparing the information you shared.')).toBeTruthy()
    expect(screen.getByText(/nothing you need to configure/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Visitor updates/ })).toBeNull()
  })

  it('reveals venue switching only when the client has multiple venues', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle() }}
        venues={[
          { id: 'riverside', name: 'Riverside' },
          { id: 'uptown', name: 'Uptown' },
        ]}
        activeUpdates={0}
      />,
    )
    const venueSwitcher = screen.getByRole('combobox', { name: 'Viewing venue' })
    expect(venueSwitcher).toBeTruthy()
    expect(
      Array.from((venueSwitcher as HTMLSelectElement).options).map((option) => option.value),
    ).toEqual(['riverside', 'uptown'])
  })

  it('shows the one required setup action without internal implementation language', () => {
    render(
      <DashboardOverview
        venue={{ id: 'venue / one', name: 'Riverside', lifecycle: lifecycle('SETUP_REQUESTED') }}
        venues={[{ id: 'venue / one', name: 'Riverside' }]}
        activeUpdates={0}
      />,
    )
    expect(screen.getByRole('link', { name: 'Share what you have' }).getAttribute('href')).toBe(
      '/venues/venue%20%2F%20one/onboarding',
    )
    expect(screen.getByRole('heading', { name: 'One thing Torchiko needs from you' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/package|worker|queue|analytics|agent/iu)
    expect(screen.queryByRole('combobox', { name: 'Viewing venue' })).toBeNull()
  })

  it('shows exactly one client task for preview and withholds live management tools', () => {
    render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({
            packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
          }),
          clientPreview: { state: 'AVAILABLE', id: 'package-approved' },
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={3}
        chatUrl="https://guest.example/riverside"
      />,
    )

    expect(screen.getByRole('heading', { name: 'One thing Torchiko needs from you' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Review the visitor experience' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open preview' }).getAttribute('href')).toBe(
      '/venues/riverside/preview/package-approved',
    )
    expect(screen.getByText(/coordinate launch timing/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open visitor guide' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Visitor updates/ })).toBeNull()
    expect(screen.queryByText(/visitor updates live/i)).toBeNull()
    expect(document.body.textContent).not.toMatch(/analytics|sessions|conversion/iu)
  })

  it('shows one support task for a paused venue and never exposes the visitor link', () => {
    render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({ wasLive: true }),
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
        impersonatedTenantName="Owner-authorized preview"
      />,
    )

    expect(screen.getByRole('heading', { name: 'Owner-authorized preview' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'One thing Torchiko needs from you' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Contact Support' }).getAttribute('href')).toBe(
      '/support?venue=riverside',
    )
    expect(screen.queryByRole('link', { name: /Open PathFinder|Open preview/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(/analytics|sessions|conversion/iu)
  })

  it('keeps essential client actions bound to the selected venue', () => {
    render(
      <DashboardOverview
        venue={{ id: 'venue / two', name: 'Uptown', lifecycle: lifecycle() }}
        venues={[
          { id: 'venue-one', name: 'Riverside' },
          { id: 'venue / two', name: 'Uptown' },
        ]}
        activeUpdates={0}
        chatUrl="https://guest.example/uptown"
      />,
    )
    expect(
      screen.getByRole('link', { name: /Visitor experience.*Open/iu }).getAttribute('href'),
    ).toBe('/ai-controls?venue=venue%20%2F%20two')
    expect(screen.getByRole('link', { name: /Help & changes.*Open/iu }).getAttribute('href')).toBe(
      '/support?venue=venue%20%2F%20two',
    )
  })

  it('renders server-derived questions before preview and optional report actions', () => {
    render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({
            packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 },
          }),
          clientPreview: { state: 'AVAILABLE', id: 'approved-preview' },
        }}
        venues={[
          { id: 'riverside', name: 'Riverside' },
          { id: 'uptown', name: 'Uptown' },
        ]}
        activeUpdates={0}
        tasks={[
          {
            id: 'missing:request-1',
            kind: 'information-request',
            title: 'Updated admission details',
            description: 'Torchiko Support is waiting for the details below.',
            href: '/support?venue=riverside&request=request-1',
            required: true,
            items: ['Current price', 'Effective date'],
          },
          {
            id: 'preview',
            kind: 'preview',
            title: 'Review the visitor experience',
            description: 'See what visitors will experience.',
            href: '/venues/riverside/preview/approved-preview',
            required: true,
          },
          {
            id: 'report',
            title: 'July review',
            description: 'A published Torchiko report is available to read.',
            href: '/weekly-reports/report-1?venue=riverside',
            required: false,
          },
        ]}
      />,
    )

    const tasks = screen.getByRole('list', { name: 'Torchiko tasks' })
    const links = Array.from(tasks.querySelectorAll('a'))
    expect(links.every((link) => link.getAttribute('aria-label') === null)).toBe(true)
    const questionLink = screen.getByRole('link', { name: 'Send these details' })
    expect(questionLink.getAttribute('href')).toBe('/support?venue=riverside&request=request-1')
    expect(questionLink.getAttribute('aria-describedby')).toBeTruthy()
    expect(
      document.getElementById(questionLink.getAttribute('aria-describedby')!)?.textContent,
    ).toBe('Updated admission details')
    expect(screen.getByText('Current price')).toBeTruthy()
    expect(screen.getByText('Effective date')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '2 things Torchiko needs from you' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Viewing venue' })).toBeTruthy()
    expect(
      questionLink.compareDocumentPosition(screen.getByRole('link', { name: 'Open preview' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Optional reading is never presented as something the venue must do.
    expect(tasks.textContent).not.toMatch(/July review/u)
    expect(screen.getByRole('link', { name: /July review/u }).getAttribute('href')).toBe(
      '/weekly-reports/report-1?venue=riverside',
    )
    expect(document.body.textContent).not.toMatch(
      /package|request-1|approved-preview|hash|analytics/iu,
    )
  })

  it('shows no task checklist when server evidence has no client action', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle('PROCESSING') }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        tasks={[]}
      />,
    )
    expect(screen.queryByRole('list', { name: 'Torchiko tasks' })).toBeNull()
    expect(screen.getByText('Nothing you need to do right now.')).toBeTruthy()
  })
  it('keeps distribution internals off the client home and explains access in plain language', () => {
    const readback = {
      website: {
        effective: false,
        reason: 'FLAG_OFF',
        framed: false,
        frameReason: null,
        origins: [],
      },
      app: { effective: false, reason: 'FLAG_OFF' },
      revision: 7,
      sessions30d: { direct: 4, qr: 12, website: 0, app: 0, unknown: 1 },
      publicUrl: 'https://guide.example/riverside/chat',
      appUrl: 'https://guide.example/app/riverside',
      appBackground: '#fbfaf6',
    }
    const { rerender } = render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle('SETUP_REQUESTED') }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guide.example/riverside/chat"
        tasks={[]}
        distributionReadback={readback}
      />,
    )
    // Before the guide is public there is no link to copy and no access summary.
    expect(screen.queryByRole('button', { name: /Copy link/ })).toBeNull()
    expect(screen.queryByText(/website or in your app/)).toBeNull()

    rerender(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle() }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guide.example/riverside/chat"
        tasks={[]}
        visitorPulse={{
          windowDays: 30,
          conversationCount: 3,
          feedback: { helpful: 1, notHelpful: 0 },
        }}
        distributionReadback={readback}
      />,
    )
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
    expect(screen.getByText('https://guide.example/riverside/chat')).toBeTruthy()
    expect(screen.getByText('Put the guide on your website or in your app')).toBeTruthy()
    expect(screen.getAllByText('Not switched on for your venue yet')).toHaveLength(2)
    // A disabled surface never hands out a link that will not work.
    expect(screen.queryByRole('button', { name: /Copy app URL/ })).toBeNull()
    expect(
      screen.getByText(/Visitors arrived by QR code 12 · direct link 4 · other 1/),
    ).toBeTruthy()
    expect(document.body.textContent).not.toMatch(
      /FLAG_OFF|revision|WebView|framed|sessions|origin/iu,
    )
  })

  it('offers app copy actions only when the app surface is switched on', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycle() }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guide.example/riverside/chat"
        tasks={[]}
        distributionReadback={{
          website: {
            effective: true,
            reason: null,
            framed: true,
            frameReason: null,
            origins: ['https://riverside.example'],
          },
          app: { effective: true, reason: null },
          revision: 2,
          sessions30d: { direct: 0, qr: 0, website: 0, app: 0, unknown: 0 },
          publicUrl: 'https://guide.example/riverside/chat',
          appUrl: 'https://guide.example/app/riverside',
          appBackground: '#fbfaf6',
        }}
      />,
    )
    expect(screen.getByText('Switched on for https://riverside.example')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy app URL' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy app background color' })).toBeTruthy()
    expect(screen.queryByText(/Visitors arrived by/)).toBeNull()
  })

  it('never says nothing is needed while Torchiko is waiting on the venue', () => {
    render(
      <DashboardOverview
        venue={{
          id: 'riverside',
          name: 'Riverside',
          lifecycle: lifecycleFrom({ reviewSourceCount: 1 }),
        }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        tasks={[
          {
            id: 'missing:trail-map',
            kind: 'information-request',
            title: 'A current trail map',
            description: 'Torchiko Support is waiting for the details below.',
            href: '/support?venue=riverside&request=trail-map',
            required: true,
            items: ['A photo of the trailhead map'],
          },
        ]}
      />,
    )
    expect(screen.getByRole('heading', { name: 'One thing Torchiko needs from you' })).toBeTruthy()
    expect(screen.getByText(/The details above are what Torchiko needs to finish/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/let you know if we need anything/iu)
    expect(screen.queryByText('Nothing you need to do right now.')).toBeNull()
  })

  it('tells a newly live venue what to do with its QR code, and stops once visitors arrive', () => {
    const props = {
      venue: { id: 'riverside', name: 'Riverside', lifecycle: lifecycle() },
      venues: [{ id: 'riverside', name: 'Riverside' }],
      activeUpdates: 0,
      chatUrl: 'https://guide.example/riverside/chat',
      tasks: [],
    }
    const { rerender } = render(
      <DashboardOverview
        {...props}
        visitorPulse={{
          windowDays: 30,
          conversationCount: 0,
          feedback: { helpful: 0, notHelpful: 0 },
        }}
      />,
    )
    expect(screen.getByText(/print the QR code for your entrance and front desk/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open QR code' }).getAttribute('href')).toBe(
      '/venues/riverside/qr-kit',
    )
    expect(
      screen.getByRole('list', { name: 'Guide progress' }).querySelector('[aria-current="step"]')
        ?.textContent,
    ).toMatch(/^Live/u)

    rerender(
      <DashboardOverview
        {...props}
        visitorPulse={{
          windowDays: 30,
          conversationCount: 40,
          feedback: { helpful: 9, notHelpful: 1 },
        }}
      />,
    )
    expect(screen.queryByText(/print the QR code for your entrance/)).toBeNull()
  })

  it('keeps the paused support route even when server evidence lists no task', () => {
    render(
      <DashboardOverview
        venue={{ id: 'riverside', name: 'Riverside', lifecycle: lifecycleFrom({ wasLive: true }) }}
        venues={[{ id: 'riverside', name: 'Riverside' }]}
        activeUpdates={0}
        chatUrl="https://guest.example/riverside"
        tasks={[]}
      />,
    )
    expect(screen.getByRole('link', { name: 'Contact Support' }).getAttribute('href')).toBe(
      '/support?venue=riverside',
    )
    expect(screen.queryByText('Nothing you need to do right now.')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open QR code' })).toBeNull()
  })
})
