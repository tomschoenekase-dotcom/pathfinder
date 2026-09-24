import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { createLocalProspectResearchReader } from '@pathfinder/api/prospect-research-reader'

import { isLocalProspectResearchRequest } from '../../../lib/local-prospect-research-boundary'
import { LocalProspectResearchDirectory } from './reader'
import {
  chicagoDirectoryParams,
  readChicagoDirectoryState,
} from '../../../lib/chicago-directory-state'

export const dynamic = 'force-dynamic'

export default async function LocalProspectResearchPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  if (!isLocalProspectResearchRequest(await headers())) notFound()
  const query = await searchParams
  if (query?.scope === 'chicago') {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query))
      if (typeof value === 'string') params.set(key, value)
    const venue = typeof query.venue === 'string' ? query.venue : undefined
    redirect(
      `/dev-fixtures/prospect-research/chicago?${chicagoDirectoryParams(readChicagoDirectoryState(params), venue)}`,
    )
  }
  const reader = createLocalProspectResearchReader()
  const territories = await reader.territories()
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-8">
      <div className="mx-auto min-w-0 max-w-7xl">
        <p className="mb-5 border-b border-slate-300 pb-4 text-sm leading-6 text-slate-700">
          Local research acceptance · real retained CRM data · read-only · no outreach or permission
          changes.
        </p>
        <LocalProspectResearchDirectory territories={territories} />
      </div>
    </main>
  )
}
