/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChicagoDirectoryResult,
  ChicagoHealth,
  ChicagoVenueDetail,
  ChicagoVenueRow,
} from '@pathfinder/api/chicago-intelligence-contract'

const mocks = vi.hoisted(() => ({ page: vi.fn(), detail: vi.fn(), health: vi.fn() }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/prospects',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => {
  const client = {
    admin: {
      listChicagoVenues: { query: mocks.page },
      getChicagoVenue: { query: mocks.detail },
      getChicagoHealth: { query: mocks.health },
    },
  }
  return { useTRPCClient: () => client }
})
import { ChicagoVenueDirectory } from './ChicagoVenueDirectory'
import { ChicagoVenueActions } from './ChicagoVenueActions'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const dimension = (value: number | null) => ({
  value,
  coverage: value === null ? 0 : 1,
  reasons: ['Fixture evidence'],
  sourceUrls: [],
  components: [],
})
const row: ChicagoVenueRow = {
  venueId: 'venue-1',
  organizationId: 'org-1',
  name: 'Harbor Museum',
  organizationName: 'Harbor Association',
  city: 'Chicago',
  state: 'IL',
  category: 'Museum',
  website: null,
  chicagoProper: true,
  revision: 1,
  relationshipState: 'DISCOVERED',
  confidence: 'unknown',
  stale: true,
  contactability: 'missing',
  reviewCount: 0,
  ranking: {
    version: 'test/1',
    venueId: 'venue-1',
    asOf: '2026-09-22',
    state: 'provisional-heuristic',
    stateReason: 'Partial evidence',
    productFit: dimension(90),
    attainability: dimension(null),
    contactability: dimension(null),
    evidenceQuality: dimension(50),
    evidenceFreshness: dimension(null),
    completeness: dimension(40),
    researchPriority: dimension(80),
    researchGaps: [],
    uncertainty: ['Decision path unknown'],
    override: null,
    rankKey: [90, null, 50, null],
  },
}
const coverage = {
  total: 1514,
  proper: 599,
  metro: 915,
  ranked: 1400,
  needsResearch: 114,
  stale: 1500,
  conflicted: 2,
  quarantined: 78,
}
const result: ChicagoDirectoryResult = {
  items: [row, { ...row, venueId: 'venue-2', name: 'Garden House', city: 'Evanston' }],
  total: 1514,
  page: 1,
  pageSize: 50,
  facets: { categories: ['Museum'], cities: ['Chicago', 'Evanston'], states: ['IL'] },
  coverage,
}
const health: ChicagoHealth = {
  rankingVersion: 'test/1',
  coverage,
  imports: [],
  reviews: [],
  jobs: [],
  matrix: [],
}
const detail: ChicagoVenueDetail = {
  ...row,
  organization: {
    id: 'org-1',
    name: 'Harbor Association',
    identityNote: 'Recorded organization and physical location are distinct identities.',
  },
  fields: {
    name: {
      value: 'Harbor Museum',
      status: 'imported-unverified',
      sourceUrls: [],
      researchedAt: null,
    },
  },
  sources: [],
  contactClaims: [],
  reviews: [],
  imports: [],
  audit: [],
  researchGaps: [],
}

describe('Chicago full-market workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/admin/prospects')
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    mocks.page.mockResolvedValue(result)
    mocks.health.mockResolvedValue(health)
    mocks.detail.mockResolvedValue(detail)
  })
  afterEach(cleanup)
  it('keeps a high-fit venue with no contact visible and explains null scores', async () => {
    render(<ChicagoVenueDirectory readOnly />)
    await screen.findByRole('button', { name: 'Harbor Museum' })
    const tableRow = screen.getByRole('row', { name: /Harbor Museum/ })
    expect(within(tableRow).getByText('90')).toBeTruthy()
    expect(within(tableRow).getAllByText('Unknown').length).toBe(2)
    expect(within(tableRow).getByText('Missing')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Harbor Museum' }))
    await screen.findByRole('heading', { name: 'Why this venue ranks here' })
    expect(screen.getByText('Partial evidence', { exact: false })).toBeTruthy()
    expect(screen.getByText('Decision path unknown')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Back to Chicago results/ }))
    await screen.findByRole('button', { name: 'Harbor Museum' })
  })
  it('applies server filters and preserves them across detail and saved-view recovery', async () => {
    render(<ChicagoVenueDirectory readOnly />)
    await screen.findByRole('button', { name: 'Harbor Museum' })
    fireEvent.change(screen.getByLabelText('Geography'), { target: { value: 'chicago-proper' } })
    await waitFor(() => expect(mocks.page.mock.calls.at(-1)?.[0].geography).toBe('chicago-proper'))
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'City museums' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save current view in this browser' }))
    expect(localStorage.getItem('torchiko.chicago-venue-views.v1')).toContain('chicago-proper')
    fireEvent.click(await screen.findByRole('button', { name: 'Harbor Museum' }))
    await screen.findByRole('heading', { name: 'Harbor Museum' })
    expect(window.location.search).toContain('geography=chicago-proper')
    expect(window.location.search).toContain('venue=venue-1')
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }))
    await waitFor(() =>
      expect(mocks.detail).toHaveBeenLastCalledWith({ venueId: 'venue-2' }, expect.anything()),
    )
  })
  it('retries failed reads without silently substituting an empty market', async () => {
    mocks.page.mockRejectedValueOnce(new Error('timeout'))
    render(<ChicagoVenueDirectory readOnly />)
    await screen.findByRole('heading', { name: 'Chicago venues could not be loaded' })
    expect(screen.queryByText('No venues match these filters')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry directory' }))
    await screen.findByRole('button', { name: 'Harbor Museum' })
  })
  it('refreshes results after a detail mutation while retaining its receipt', async () => {
    const act = vi.fn().mockResolvedValue({ receiptId: 'accepted-detail-receipt', revision: 2 })
    render(<ChicagoVenueDirectory act={act} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Harbor Museum' }))
    await screen.findByRole('heading', { name: 'Harbor Museum' })
    for (const [label, value] of [
      ['Verified value', 'https://example.org'],
      ['Exact first-party source URL', 'https://example.org/about'],
      ['What the source actually establishes', 'Synthetic test evidence for this venue field.'],
    ])
      fireEvent.change(screen.getByLabelText(label!), { target: { value } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Propose field change' }))
    await screen.findByRole('heading', { name: 'Mutation result & audit receipt' })
    await waitFor(() => expect(mocks.page).toHaveBeenCalledTimes(2))
    expect(screen.getByText(/accepted-detail-receipt/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Harbor Museum' })).toBeTruthy()
  })
  it('does not reopen a detail when an adjacent-page request completes after returning to results', async () => {
    let finish!: (value: ChicagoDirectoryResult) => void
    const nextPage = new Promise<ChicagoDirectoryResult>((resolve) => {
      finish = resolve
    })
    mocks.page.mockResolvedValueOnce(result).mockReturnValueOnce(nextPage)
    render(<ChicagoVenueDirectory readOnly />)
    fireEvent.click(await screen.findByRole('button', { name: 'Garden House' }))
    await screen.findByRole('heading', { name: 'Why this venue ranks here' })
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }))
    await screen.findByText('Loading adjacent results…')
    fireEvent.click(screen.getByRole('button', { name: /Back to Chicago results/ }))
    finish({ ...result, page: 2, items: [{ ...row, venueId: 'late-result' }] })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Chicago venues' })).toBeTruthy(),
    )
    expect(window.location.search).not.toContain('late-result')
    expect(screen.queryByRole('heading', { name: 'Why this venue ranks here' })).toBeNull()
  })
  it('renders coverage and the operator import/review/lease surface', async () => {
    render(<ChicagoVenueDirectory readOnly />)
    fireEvent.click(screen.getByRole('button', { name: 'Data health & imports' }))
    await screen.findByRole('heading', { name: 'Source versions' })
    expect(screen.getByRole('heading', { name: 'Research leases & recovery' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Review queue (0)' })).toBeTruthy()
  })
  it('retries an ambiguous mutation with the same immutable request and key', async () => {
    const act = vi
      .fn()
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValue({ receiptId: 'receipt-1', replay: true })
    render(
      <ChicagoVenueActions territoryId="chicago-metro" act={act} onSuccess={() => undefined} />,
    )
    for (const [label, value] of [
      ['Venue name', 'Local Museum'],
      ['City', 'Chicago'],
      ['Official venue website', 'https://example.org'],
      [
        'Evidence for Chicago operating territory membership',
        'First-party page records Chicago location.',
      ],
      ['Exact first-party source URL', 'https://example.org/about'],
      [
        'What the source actually establishes',
        'The official website lists the museum at a physical Chicago location.',
      ],
    ])
      fireEvent.change(screen.getByLabelText(label!), { target: { value } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Add venue with receipt' }))
    await screen.findByRole('button', { name: 'Retry exact request / recover receipt' })
    const first = act.mock.calls[0]![0]
    expect(sessionStorage.getItem('torchiko.chicago.pending.new')).toContain(
      first.input.idempotencyKey,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact request / recover receipt' }))
    await screen.findByRole('heading', { name: 'Mutation result & audit receipt' })
    expect(act.mock.calls[1]![0]).toEqual(first)
    expect(sessionStorage.getItem('torchiko.chicago.pending.new')).toBeNull()
  })
  it('preserves unreadable pending requests before permitting a replacement', async () => {
    sessionStorage.setItem('torchiko.chicago.pending.new', '{old-schema')
    const act = vi.fn()
    render(
      <ChicagoVenueActions territoryId="chicago-metro" act={act} onSuccess={() => undefined} />,
    )
    await screen.findByRole('button', {
      name: 'Retain unreadable recovery text before a new request',
    })
    expect(
      (
        screen
          .getByRole('button', { name: 'Add venue with receipt' })
          .closest('fieldset') as HTMLFieldSetElement
      ).disabled,
    ).toBe(true)
    fireEvent.click(
      screen.getByRole('button', { name: 'Retain unreadable recovery text before a new request' }),
    )
    expect(sessionStorage.getItem('torchiko.chicago.pending.new')).toBeNull()
    const retained = Object.keys(sessionStorage).find((key) =>
      key.startsWith('torchiko.chicago.pending.new.unreadable.'),
    )
    expect(retained && sessionStorage.getItem(retained)).toBe('{old-schema')
    expect(act).not.toHaveBeenCalled()
  })
})
