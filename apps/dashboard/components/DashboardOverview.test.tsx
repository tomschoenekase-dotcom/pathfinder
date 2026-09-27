/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

import { DashboardOverviewView, type HomeRequest } from './DashboardOverview'

const venue = { id: 'venue alpha', name: 'Maple Hollow Nature Center' }
const url = 'https://guide.example.com/maple-hollow/chat'

const reply: HomeRequest = {
  id: 'request-1',
  title: 'Add fall hours',
  detail: 'Your fall opening hours · A photo of the hours sign',
  needsYou: true,
  meta: 'Requested Sep 24',
  href: '/support?venue=venue%20alpha&request=request-1',
  actionLabel: 'Reply',
}
const working: HomeRequest = {
  id: 'request-2',
  title: 'Update the trail map',
  detail: null,
  needsYou: false,
  meta: 'In review · Sep 22',
  href: '/support?venue=venue%20alpha&request=request-2',
  actionLabel: 'View',
}

function renderHome(overrides: Partial<Parameters<typeof DashboardOverviewView>[0]> = {}) {
  return render(
    <DashboardOverviewView
      venue={venue}
      venues={[venue]}
      guide={{ kind: 'published', url }}
      requests={[reply, working]}
      sendSection={<section aria-label="Send us information">send</section>}
      paymentSection={<section aria-label="Payment">payment</section>}
      {...overrides}
    />,
  )
}

describe('client Home', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('does the four jobs and nothing else', () => {
    renderHome()
    expect(screen.getByRole('heading', { level: 1, name: venue.name })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Your visitor guide' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Send us information' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Payment' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Open requests' })).toBeTruthy()
    const text = document.body.textContent ?? ''
    // No launch celebration, progress rail, live badge or visitor statistics.
    expect(text).not.toMatch(
      /is live|Live\b|Torchiko builds|You preview|visitor conversations|helpful ratings|last 30 days/iu,
    )
    expect(screen.queryByRole('list', { name: 'Guide progress' })).toBeNull()
  })

  it('shares the exact visitor link, opens it, and encodes the same destination in the QR code', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderHome()
    const field = screen.getByLabelText<HTMLInputElement>(`Visitor guide link for ${venue.name}`)
    expect(field.value).toBe(url)
    expect(field.readOnly).toBe(true)
    const open = screen.getByRole('link', { name: /Open/ })
    expect(open.getAttribute('href')).toBe(url)
    expect(open.getAttribute('target')).toBe('_blank')
    const qr = screen.getByRole('img', {
      name: `QR code that opens the ${venue.name} visitor guide`,
    })
    expect(qr.getAttribute('data-qr-value')).toBe(`${url}?source=qr`)
    expect(screen.getByRole('link', { name: /Download or print/ }).getAttribute('href')).toBe(
      '/venues/venue%20alpha/qr-kit',
    )

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
    expect(writeText).toHaveBeenCalledWith(url)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(screen.getByText('Link copied.')).toBeTruthy()
  })

  it('selects the link for manual copying when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    renderHome()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
    expect(screen.getByText(/The link is selected so you can copy it yourself/u)).toBeTruthy()
  })

  it.each([
    ['building', /still putting your guide together/u],
    ['preview', /ready for you to preview/u],
    ['paused', /paused, so visitors can’t open it/u],
    ['link-unavailable', /couldn’t load your visitor link/u],
  ] as const)('tells the truth when the guide is %s and shows no link or QR code', (kind, copy) => {
    renderHome({ guide: { kind } })
    expect(screen.getByText(copy)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('img', { name: /QR code/u })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })

  it('marks only what the venue owes and gives it an obvious answer', () => {
    renderHome()
    const requests = screen.getByRole('region', { name: /Open requests/u })
    expect(within(requests).getByLabelText('1 waiting for you')).toBeTruthy()
    const answer = within(requests).getByRole('link', { name: 'Reply' })
    expect(answer.getAttribute('href')).toBe(reply.href)
    expect(within(requests).getByText('(waiting for you)')).toBeTruthy()
    expect(within(requests).getByText('(Torchiko is working on it)')).toBeTruthy()
    expect(within(requests).getByRole('link', { name: /View/u }).getAttribute('href')).toBe(
      working.href,
    )
  })

  it('shows no badge while only Torchiko is working, and one quiet line when nothing is open', () => {
    const { unmount } = renderHome({ requests: [working] })
    expect(screen.queryByLabelText(/waiting for you/u)).toBeNull()
    unmount()
    renderHome({ requests: [] })
    expect(screen.getByText('Nothing open with Torchiko right now.')).toBeTruthy()
  })

  it('omits payment entirely when billing is not part of this portal', () => {
    renderHome({ paymentSection: null })
    expect(screen.queryByRole('region', { name: 'Payment' })).toBeNull()
  })

  it('reveals venue switching only for multiple venues', () => {
    const { unmount } = renderHome()
    expect(screen.queryByLabelText('Venue')).toBeNull()
    unmount()
    renderHome({ venues: [venue, { id: 'venue-b', name: 'Riverside Museum' }] })
    expect(screen.getByLabelText<HTMLSelectElement>('Venue').value).toBe(venue.id)
  })

  it('keeps long names, links and request titles inside their containers', () => {
    const long = 'The Greater Maple Hollow Regional Nature Center and Wetland Education Preserve'
    renderHome({
      venue: { id: venue.id, name: long },
      requests: [{ ...reply, title: `${long} parking arrangements for the winter season` }],
    })
    expect(screen.getByRole('heading', { level: 1 }).className).toContain('break-words')
    expect(screen.getByLabelText<HTMLInputElement>(/Visitor guide link/u).className).toContain(
      'truncate',
    )
  })
})
