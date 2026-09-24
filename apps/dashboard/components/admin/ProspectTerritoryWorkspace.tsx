import Link from 'next/link'
import type {
  readProspectGeographySummary,
  readResearchTerritories,
  readProspectGeographyHolds,
} from '@pathfinder/db'
import {
  AuthenticatedProspectGeographyPanel,
  LocalProspectGeographyPanel,
} from './ProspectGeographyReviewPanel'
import { ProspectCountyResearchPanel } from './ProspectCountyResearchPanel'

type Props = {
  summary: Awaited<ReturnType<typeof readProspectGeographySummary>>
  catalog: Awaited<ReturnType<typeof readResearchTerritories>>
  holds: Awaited<ReturnType<typeof readProspectGeographyHolds>>
  baseHref: string
  directoryHref: string
  state: string
  corridor: boolean
  local?: boolean
  query?: string
  recordQuery?: string
  recordScope?: 'chicago' | 'all'
  recordStatus?: 'HELD' | 'ASSIGNED' | 'ALL'
  selectedVenueId?: string
  recordTerritoryCode?: string
  recordCountyGeoid?: string
  recordState?: string
}
const fmt = (n: number) => n.toLocaleString('en-US')
export function ProspectTerritoryWorkspace({
  summary,
  catalog,
  holds,
  baseHref,
  directoryHref,
  state,
  corridor,
  local = false,
  query = '',
  recordQuery = '',
  recordScope = 'chicago',
  recordStatus = 'HELD',
  selectedVenueId,
  recordTerritoryCode = '',
  recordCountyGeoid = '',
  recordState = '',
}: Props) {
  const common = {
    state,
    scope: corridor ? 'corridor' : 'all',
    query,
    recordQuery,
    recordScope,
    recordStatus,
    recordTerritoryCode,
    recordCountyGeoid,
    recordState,
  }
  const pageLink = (page: number) =>
    `${baseHref}?${new URLSearchParams({ ...common, page: String(page), recordsPage: String(holds.page) }).toString()}`
  const recordsLink = (page: number, id?: string) =>
    `${baseHref}?${new URLSearchParams({ ...common, page: String(catalog.page), recordsPage: String(page), ...(id ? { venue: id } : {}) }).toString()}#county-holds`
  const assignedLink = (code: string, county = '') =>
    `${baseHref}?${new URLSearchParams({ ...common, page: String(catalog.page), recordsPage: '1', recordQuery: '', recordScope: 'all', recordStatus: 'ASSIGNED', recordTerritoryCode: code, recordCountyGeoid: county, recordState: '' }).toString()}#county-holds`
  return (
    <main className="mx-auto min-w-0 max-w-[1440px] px-4 py-6 text-slate-900 sm:px-8">
      <Link
        href={directoryHref}
        className="inline-flex min-h-11 items-center text-sm font-medium text-emerald-800 underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
      >
        Back to prospects
      </Link>
      <header className="mb-7 border-b border-slate-200 pb-6">
        <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-emerald-800">
          Torchiko / Research ownership
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Territories, without the guesswork
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-7 text-slate-600">
          One county, one research owner. Chicago stays a sales view across those boundaries.
          Existing source sheets and native venue identities remain intact.
        </p>
        {local && (
          <p className="mt-3 text-sm font-medium text-amber-900">
            Retained local CRM · live database reads · not a hosted deployment
          </p>
        )}
      </header>
      {!summary.installed ? (
        <section role="status" className="border-l-4 border-amber-500 bg-amber-50 p-5">
          <h2 className="font-semibold">Registry not installed in this instance</h2>
          <p className="mt-2">
            The approved source is available, but this database has not admitted it. No territory or
            prospect was changed by opening this page.
          </p>
        </section>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-b border-slate-200 pb-6 lg:grid-cols-4">
            {[
              ['Research territories', summary.territories],
              ['Counties / equivalents', summary.counties],
              ['Verified venue assignments', summary.assigned],
              ['County checks still needed', summary.held],
            ].map(([title, n]) => (
              <div key={title}>
                <dt className="text-sm text-slate-600">{title}</dt>
                <dd className="mt-1 text-3xl font-semibold tabular-nums">{fmt(Number(n))}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            {fmt(summary.nativeTotal)} total native CRM venues, including non-import and archived
            records. The retained import population is {fmt(summary.importedLineageCount)} distinct
            native venues: {fmt(summary.importedAssigned)} assigned, {fmt(summary.importedHeld)}{' '}
            held, and {fmt(summary.importedUninitialized)} not initialized. The workspace counts and
            lists above cover active venues under active organizations.
          </p>
          <section
            aria-labelledby="geography-progress"
            className="my-7 border-l-4 border-amber-500 bg-amber-50 px-5 py-4"
          >
            <h2 id="geography-progress" className="font-semibold">
              A defined boundary is not a verified venue address
            </h2>
            <p className="mt-2 max-w-5xl text-sm leading-6 text-amber-950">
              {fmt(summary.chicagoAssigned)} Chicago venues have an evidence-backed county
              assignment; {fmt(summary.chicagoHeld)} still need a physical-location check. A legacy
              city, ZIP or sheet name is not silently converted into a county. Public contact
              details do not establish permission or deliverability.
            </p>
          </section>
          <section aria-labelledby="territory-catalog">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 id="territory-catalog" className="text-xl font-semibold">
                  Canonical research territories
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  {fmt(catalog.total)} matching territories. Open a row for exact county codes.
                </p>
              </div>
              <form action={baseHref} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="recordQuery" value={recordQuery} />
                <input type="hidden" name="recordScope" value={recordScope} />
                <input type="hidden" name="recordStatus" value={recordStatus} />
                <input type="hidden" name="recordTerritoryCode" value={recordTerritoryCode} />
                <input type="hidden" name="recordCountyGeoid" value={recordCountyGeoid} />
                <input type="hidden" name="recordState" value={recordState} />
                <input type="hidden" name="recordsPage" value={holds.page} />
                <label className="text-sm font-medium">
                  Territory or county
                  <input
                    name="query"
                    defaultValue={query}
                    maxLength={200}
                    placeholder="Name or territory ID"
                    className="mt-1 block min-h-11 max-w-full rounded-md border border-slate-300 bg-white px-3"
                  />
                </label>
                <label className="text-sm font-medium">
                  View
                  <select
                    name="scope"
                    defaultValue={corridor ? 'corridor' : 'all'}
                    className="mt-1 block min-h-11 rounded-md border border-slate-300 bg-white px-3"
                  >
                    <option value="corridor">Chicago–Milwaukee corridor</option>
                    <option value="all">All contiguous U.S.</option>
                  </select>
                </label>
                <label className="text-sm font-medium">
                  State code
                  <input
                    name="state"
                    defaultValue={state}
                    placeholder="All"
                    pattern="[A-Za-z]{2}|"
                    maxLength={2}
                    className="mt-1 block min-h-11 w-24 rounded-md border border-slate-300 bg-white px-3 uppercase"
                  />
                </label>
                <button className="min-h-11 rounded-md bg-emerald-800 px-5 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                  Apply
                </button>
              </form>
            </div>
            <div className="mt-5 divide-y divide-slate-200 border-y border-slate-200">
              {!catalog.items.length && (
                <p className="py-7 text-slate-600">
                  No territories match this view. Clear the state code or use All contiguous U.S.
                </p>
              )}
              {catalog.items.map((t) => (
                <details key={t.code} className="group py-1">
                  <summary className="cursor-pointer list-none px-1 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-700">
                    <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_11rem_12rem]">
                      <div className="min-w-0">
                        <span className="mr-2 text-emerald-800" aria-hidden="true">
                          +
                        </span>
                        <span className="font-semibold">{t.name}</span>
                        <span className="mt-1 block break-all font-mono text-xs text-slate-500">
                          {t.code}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600">
                        {t.counties.length}{' '}
                        {t.counties.length === 1 ? 'county' : 'counties / equivalents'}
                      </p>
                      <p className="text-sm text-slate-600">
                        {fmt(t.assignedVenues)} verified assignments
                      </p>
                    </div>
                  </summary>
                  <div className="border-t border-dashed border-slate-200 bg-slate-50 px-4 py-4">
                    <p className="mb-3 text-sm text-slate-600">
                      Only these physical counties belong to this territory. Zero assigned venues
                      does not mean no venues exist.
                    </p>
                    <ul className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
                      {t.counties.map((c) => (
                        <li key={c.countyGeoid}>
                          <Link
                            href={assignedLink(t.code, c.countyGeoid)}
                            className="inline-flex min-h-11 items-center text-emerald-800 underline"
                          >
                            <span className="mr-2 font-mono text-xs">{c.countyGeoid}</span>
                            {c.countyName}, {c.state}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={assignedLink(t.code)}
                      className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-emerald-800 underline"
                    >
                      Open assigned prospects
                    </Link>
                  </div>
                </details>
              ))}
            </div>
            <nav
              aria-label="Territory pages"
              className="my-4 flex min-h-11 items-center justify-between text-sm"
            >
              {catalog.page > 1 ? (
                <Link
                  className="min-h-11 px-2 py-3 text-emerald-800 underline"
                  href={pageLink(catalog.page - 1)}
                >
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span>
                Page {catalog.page} of {Math.max(1, Math.ceil(catalog.total / catalog.limit))}
              </span>
              {catalog.hasMore ? (
                <Link
                  className="min-h-11 px-2 py-3 text-emerald-800 underline"
                  href={pageLink(catalog.page + 1)}
                >
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          </section>
          <section className="mt-9 border-t border-slate-200 pt-6" aria-labelledby="county-holds">
            <h2 id="county-holds" className="text-xl font-semibold">
              {recordScope === 'chicago' ? 'Chicago location checks' : 'Location checks'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Showing {holds.items.length} of {fmt(holds.total)} matching CRM locations. These are
              data-quality records, not outreach selections.
            </p>
            <form
              action={`${baseHref}#county-holds`}
              className="mt-4 flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="scope" value={corridor ? 'corridor' : 'all'} />
              <input type="hidden" name="state" value={state} />
              <input type="hidden" name="query" value={query} />
              <input type="hidden" name="page" value={catalog.page} />
              <input type="hidden" name="recordTerritoryCode" value={recordTerritoryCode} />
              <input type="hidden" name="recordCountyGeoid" value={recordCountyGeoid} />
              <label className="text-sm font-medium">
                Location or city
                <input
                  name="recordQuery"
                  defaultValue={recordQuery}
                  maxLength={200}
                  className="mt-1 block min-h-11 max-w-full rounded-md border border-slate-300 bg-white px-3"
                />
              </label>
              <label className="text-sm font-medium">
                Location state
                <input
                  name="recordState"
                  defaultValue={recordState}
                  pattern="[A-Za-z]{2}|"
                  maxLength={2}
                  placeholder="All"
                  className="mt-1 block min-h-11 w-24 rounded-md border border-slate-300 bg-white px-3 uppercase"
                />
              </label>
              <label className="text-sm font-medium">
                Record set
                <select
                  name="recordScope"
                  defaultValue={recordScope}
                  className="mt-1 block min-h-11 rounded-md border border-slate-300 bg-white px-3"
                >
                  <option value="chicago">Chicago operating view</option>
                  <option value="all">All CRM locations</option>
                </select>
              </label>
              <label className="text-sm font-medium">
                County status
                <select
                  name="recordStatus"
                  defaultValue={recordStatus}
                  className="mt-1 block min-h-11 rounded-md border border-slate-300 bg-white px-3"
                >
                  <option value="HELD">Needs county evidence</option>
                  <option value="ASSIGNED">Assigned</option>
                  <option value="ALL">All statuses</option>
                </select>
              </label>
              <button className="min-h-11 rounded-md bg-emerald-800 px-5 font-medium text-white focus-visible:outline focus-visible:outline-2">
                Filter locations
              </button>
            </form>
            {(recordTerritoryCode || recordCountyGeoid) && (
              <p className="mt-3 break-words text-sm text-slate-600">
                Research owner: {recordTerritoryCode || 'Any'}
                {recordCountyGeoid ? ` · County ${recordCountyGeoid}` : ''}.{' '}
                <Link
                  className="inline-flex min-h-11 items-center text-emerald-800 underline"
                  href={`${baseHref}?${new URLSearchParams({ ...common, page: String(catalog.page), recordsPage: '1', recordTerritoryCode: '', recordCountyGeoid: '' }).toString()}#county-holds`}
                >
                  Clear owner filter
                </Link>
              </p>
            )}
            {selectedVenueId &&
              (local ? (
                <LocalProspectGeographyPanel key={selectedVenueId} venueId={selectedVenueId} />
              ) : (
                <AuthenticatedProspectGeographyPanel
                  key={selectedVenueId}
                  venueId={selectedVenueId}
                />
              ))}
            {!holds.items.length && (
              <p role="status" className="mt-5 border border-slate-200 p-4 text-sm">
                No locations match these filters. Clear the search or select all statuses.
              </p>
            )}
            <div className="mt-4 divide-y divide-slate-200">
              {holds.items.map((h) => (
                <article key={h.venueId} className="py-4">
                  <Link
                    href={recordsLink(holds.page, h.venueId)}
                    className="inline-flex min-h-11 items-center font-medium text-emerald-800 underline"
                  >
                    {h.venue.name}
                  </Link>
                  <p className="mt-1 text-sm text-slate-600">
                    {h.venue.city ?? 'City unknown'}, {h.venue.region ?? 'state unknown'} ·{' '}
                    {h.legacyTerritory?.name ?? 'No legacy sheet'}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{h.reason}</p>
                  <Link
                    href={`${directoryHref}/${h.venue.organizationId}${local ? '' : `?venue=${encodeURIComponent(h.venueId)}#physical-geography`}`}
                    className="mt-1 inline-flex min-h-11 items-center text-xs text-emerald-800 underline"
                  >
                    Full prospect record
                  </Link>
                </article>
              ))}
            </div>
            <nav
              aria-label="Location record pages"
              className="mt-4 flex items-center justify-between gap-3 text-sm"
            >
              {holds.page > 1 ? (
                <Link
                  className="min-h-11 px-2 py-3 text-emerald-800 underline"
                  href={recordsLink(holds.page - 1)}
                >
                  Previous locations
                </Link>
              ) : (
                <span />
              )}
              <span>
                Page {holds.page} of {Math.max(1, Math.ceil(holds.total / holds.limit))}
              </span>
              {holds.hasMore ? (
                <Link
                  className="min-h-11 px-2 py-3 text-emerald-800 underline"
                  href={recordsLink(holds.page + 1)}
                >
                  Next locations
                </Link>
              ) : (
                <span />
              )}
            </nav>
          </section>
          {!local && <ProspectCountyResearchPanel registryHash={summary.registryHash} />}
          <footer className="mt-8 border-t border-slate-200 pt-4 text-xs leading-6 text-slate-500">
            <p className="break-all">Model {summary.version}</p>
            <p className="break-all">Registry SHA-256 {summary.registryHash}</p>
            <p>
              Registry approval, discovery progress, identity review and permission to contact are
              separate states.
            </p>
          </footer>
        </>
      )}
    </main>
  )
}
