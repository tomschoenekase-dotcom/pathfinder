import { ProspectTerritoryWorkspace } from '../../../../../components/admin/ProspectTerritoryWorkspace'
import { createAdminCaller } from '../../../../../lib/admin-caller'
export const dynamic = 'force-dynamic'
export default async function TerritoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams,
    state =
      typeof params.state === 'string' && /^[A-Za-z]{2}$/.test(params.state)
        ? params.state.toUpperCase()
        : ''
  const corridor = params.scope !== 'all',
    page = Math.min(100000, Math.max(1, Number(params.page) || 1))
  const query = typeof params.query === 'string' ? params.query.slice(0, 200) : '',
    recordQuery = typeof params.recordQuery === 'string' ? params.recordQuery.slice(0, 200) : ''
  const recordScope = params.recordScope === 'all' ? 'all' : 'chicago',
    recordStatus =
      params.recordStatus === 'ASSIGNED'
        ? 'ASSIGNED'
        : params.recordStatus === 'ALL'
          ? 'ALL'
          : 'HELD'
  const recordTerritoryCode =
      typeof params.recordTerritoryCode === 'string'
        ? params.recordTerritoryCode.slice(0, 100)
        : '',
    recordCountyGeoid =
      typeof params.recordCountyGeoid === 'string' && /^\d{5}$/.test(params.recordCountyGeoid)
        ? params.recordCountyGeoid
        : '',
    recordState =
      typeof params.recordState === 'string' && /^[A-Za-z]{2}$/.test(params.recordState)
        ? params.recordState.toUpperCase()
        : ''
  const recordsPage = Math.trunc(Math.min(100000, Math.max(1, Number(params.recordsPage) || 1))),
    selectedVenueId = typeof params.venue === 'string' ? params.venue.slice(0, 191) : undefined
  const caller = await createAdminCaller(),
    legacy = await caller.admin.listProspectTerritories()
  const chicago = legacy.find((t) => t.name === 'Chicago Metro')
  const [summary, catalog, holds] = await Promise.all([
    caller.admin.getProspectTerritoryModel({}),
    caller.admin.listResearchTerritories({
      page: Math.trunc(page),
      limit: 50,
      corridor,
      query,
      ...(state ? { state } : {}),
    }),
    caller.admin.listProspectGeographyHolds({
      page: recordsPage,
      limit: 20,
      query: recordQuery,
      status: recordStatus,
      ...(recordState ? { state: recordState } : {}),
      ...(recordTerritoryCode ? { territoryCode: recordTerritoryCode } : {}),
      ...(recordCountyGeoid ? { countyGeoid: recordCountyGeoid } : {}),
      ...(recordScope === 'chicago'
        ? { legacyTerritoryId: chicago?.id ?? 'missing-chicago-legacy-territory' }
        : {}),
    }),
  ])
  return (
    <ProspectTerritoryWorkspace
      summary={summary}
      catalog={catalog}
      holds={holds}
      baseHref="/admin/prospects/territories"
      directoryHref="/admin/prospects"
      state={state}
      corridor={corridor}
      query={query}
      recordQuery={recordQuery}
      recordScope={recordScope}
      recordStatus={recordStatus}
      recordTerritoryCode={recordTerritoryCode}
      recordCountyGeoid={recordCountyGeoid}
      recordState={recordState}
      {...(selectedVenueId ? { selectedVenueId } : {})}
    />
  )
}
