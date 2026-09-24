'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SalesWorkflowView } from '@pathfinder/api/prospect-sales-contract'

import { ProspectPreparationWorkspace } from '../../../../components/admin/ProspectPreparationWorkspace'
import type {
  PreparationWorkspaceTransport,
  WorkspaceOrganization,
} from '../../../../lib/prospect-preparation-workspace'

function requestError(result: unknown, fallback: string) {
  return result &&
    typeof result === 'object' &&
    typeof (result as { error?: unknown }).error === 'string'
    ? (result as { error: string }).error
    : fallback
}

function isSalesWorkflowView(value: unknown): value is SalesWorkflowView {
  if (!value || typeof value !== 'object') return false
  const view = value as Record<string, unknown>
  return (
    typeof view.venueId === 'string' &&
    typeof view.organizationId === 'string' &&
    typeof view.snapshotHash === 'string' &&
    view.SEND_AUTHORIZED === false &&
    view.senderAvailable === false &&
    Array.isArray(view.contacts) &&
    Array.isArray(view.threadCandidates)
  )
}

export function FixturePreparationWorkspace({ organizationIds }: { organizationIds: string[] }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const [mode, setMode] = useState<'selected' | 'reopen' | null>(null)
  const transport = useMemo<PreparationWorkspaceTransport>(
    () => ({
      async readOrganization(organizationId) {
        const response = await fetch(
          `/dev-fixtures/prospect-research/workspace/data?organizationId=${encodeURIComponent(organizationId)}`,
          { cache: 'no-store', credentials: 'same-origin' },
        )
        const result = (await response.json()) as WorkspaceOrganization | { error?: unknown }
        if (response.status === 404) return null
        if (!response.ok)
          throw new Error(requestError(result, 'Synthetic CRM record is unavailable'))
        return result as WorkspaceOrganization
      },
      async load(venueId) {
        const response = await fetch(
          `/dev-fixtures/prospect-research/workspace/sales?venueId=${encodeURIComponent(venueId)}`,
          { cache: 'no-store', credentials: 'same-origin' },
        )
        const result = (await response.json()) as unknown
        if (!response.ok)
          throw new Error(requestError(result, 'Synthetic CRM sales view is unavailable'))
        if (!isSalesWorkflowView(result))
          throw new Error(
            'Synthetic CRM sales view is incomplete; retry without changing the selection',
          )
        return result
      },
      async act() {
        throw new Error(
          'This rendered fixture is read-only. It exposes native state and existing recovery holds, not a local mutation actor.',
        )
      },
    }),
    [],
  )

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-700">
        <p>
          Open reads the listed synthetic records. Reopen restores only saved synthetic IDs,
          venue/thread choices, and receipt references.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!mounted}
            onClick={() => setMode('selected')}
            className="min-h-10 rounded-md bg-slate-950 px-3 py-2 font-semibold text-white hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
          >
            Open selected synthetic records
          </button>
          <button
            type="button"
            disabled={!mounted}
            onClick={() => setMode('reopen')}
            className="min-h-10 rounded-md border border-slate-400 bg-white px-3 py-2 font-semibold text-slate-900 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
          >
            Reopen retained synthetic selection
          </button>
        </div>
      </div>
      {mode ? (
        <ProspectPreparationWorkspace
          key={mode}
          organizationIds={mode === 'reopen' ? [] : organizationIds}
          transport={transport}
          directoryHref="/dev-fixtures/prospect-research"
          reopenSession={mode === 'reopen'}
        />
      ) : (
        <p
          className="border-y border-slate-300 bg-white px-4 py-5 text-sm leading-6 text-slate-700"
          role="status"
        >
          No synthetic CRM record has been read. Choose an explicit open or reopen action above.
        </p>
      )}
    </>
  )
}
