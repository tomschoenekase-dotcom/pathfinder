import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { localFirstSendRehearsalEnabled } from '@pathfinder/db'

import { isLocalProspectResearchRequest } from '../../../../lib/local-prospect-research-boundary'
import { FixturePreparationWorkspace } from './FixturePreparationWorkspace'

export const dynamic = 'force-dynamic'

const syntheticOrganization = /^SYN-CRM-FIRSTSEND-ORG-r\d+$/

function selectedOrganizations(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(values)]
}

/** Isolated rendered proof surface. It cannot discover, read, or prepare normal CRM records. */
export default async function SyntheticPreparationWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string | string[] }>
}) {
  if (!isLocalProspectResearchRequest(await headers()) || !localFirstSendRehearsalEnabled())
    notFound()
  const organizationIds = selectedOrganizations((await searchParams).organizationId)
  if (
    !organizationIds.length ||
    organizationIds.length > 10 ||
    !organizationIds.every((id) => syntheticOrganization.test(id))
  )
    notFound()
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-8">
      <div className="mx-auto min-w-0 max-w-7xl">
        <div className="mb-5 border-y border-amber-300 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-950">
          <p className="font-bold">
            Synthetic local preparation fixture · no authenticated CRM or provider access
          </p>
          <p className="mt-1">
            This page accepts only explicit <code>SYN-CRM-FIRSTSEND-ORG-rNNN</code> IDs under the
            existing loopback rehearsal flags. It reads the retained synthetic CRM source and may
            show an already persisted preparation, draft, or recovery hold. A saved-guide selection
            is intentionally unavailable here, so this fixture can hold preparation rather than
            inventing guide readiness or model output.
          </p>
        </div>
        <FixturePreparationWorkspace organizationIds={organizationIds} />
      </div>
    </main>
  )
}
