import { headers } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createLocalChicagoIntelligenceCaller } from '@pathfinder/api/chicago-intelligence-local'
import { isLocalProspectResearchRequest } from '../../../../lib/local-prospect-research-boundary'
import { LocalChicagoIntelligenceWorkspace } from './reader'

export const dynamic = 'force-dynamic'
export default async function LocalChicagoIntelligencePage() {
  if (!isLocalProspectResearchRequest(await headers())) notFound()
  const caller = createLocalChicagoIntelligenceCaller()
  const territoryId = await caller.territoryId()
  const retainedLocal =
    process.env.TORCHIKO_CHICAGO_RETAINED_LOCAL_ENABLED === '1' &&
    new URL(process.env.DATABASE_URL!).pathname === '/pathfinder_disposable_crm_research_20260919'
  return (
    <main className="min-h-screen bg-white px-4 py-6 sm:px-8">
      <div className="mx-auto min-w-0 max-w-[1440px]">
        <p className="mb-5 border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          {retainedLocal
            ? 'Local Chicago workspace · retained local CRM database · current venue intelligence and immutable source history.'
            : 'Local Chicago acceptance fixture · isolated disposable database · actual Chicago API and imported source rows. Additions named TEST ONLY are synthetic verification records.'}{' '}
          No email, campaign, account or hosted deployment access.
        </p>
        <nav aria-label="Research ownership" className="mb-4 flex justify-end">
          <Link
            href="/dev-fixtures/prospect-research/territories"
            className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-emerald-800 underline underline-offset-4"
          >
            Research territories &amp; county checks
          </Link>
        </nav>
        <LocalChicagoIntelligenceWorkspace territoryId={territoryId} />
      </div>
    </main>
  )
}
