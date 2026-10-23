'use client'

import React, { useMemo, useRef, useState } from 'react'
import { GeneralizedContentRevisionDraft } from '@pathfinder/contracts/universal-content-actions'
import { GeneralizedContentWorkbench } from '../../../components/admin/GeneralizedContentWorkbench'
import { FixtureTRPCClientProvider, type DashboardTRPCClient } from '../../../lib/trpc'

type Module = React.ComponentProps<typeof GeneralizedContentWorkbench>['modules'][number]
const initial: Module = {
  id: 'fixture-fact',
  revisionId: 'fixture-revision-3',
  version: 3,
  kind: 'OPERATIONAL_FACT',
  audience: 'PUBLIC',
  effectiveFrom: null,
  effectiveUntil: null,
  publishedRevisionId: 'fixture-revision-3',
  payload: {
    kind: 'OPERATIONAL_FACT',
    label: 'Coat check entry',
    value: 'Enter coat check through the north door.',
    applicability: { scope: 'SUBJECTS', subjectModuleIds: ['fixture-coat-check'], placeIds: [] },
  },
}

export function FixtureClient() {
  const [modules, setModules] = useState([initial])
  const current = useRef(initial)
  const [ledger, setLedger] = useState('No mock write recorded.')
  const client = useMemo(() => {
    function validate(input: unknown) {
      const draft = GeneralizedContentRevisionDraft.parse(input)
      const scope =
        draft.payload.kind === 'OPERATIONAL_FACT' ? draft.payload.applicability : undefined
      // Synthetic reference checks only. Actual tenant/visibility checks remain server/DB proof.
      if (
        scope?.scope === 'SUBJECTS' &&
        (scope.subjectModuleIds.some((id) => id !== 'fixture-coat-check') ||
          scope.placeIds.some((id) => id !== 'fixture-north-door'))
      ) {
        throw new Error('Synthetic target unavailable')
      }
      return draft
    }
    function append(input: { draft: unknown; expectedLatestVersion: number }) {
      if (input.expectedLatestVersion !== current.current.version)
        throw Object.assign(new Error('Conflict'), { data: { code: 'CONFLICT' } })
      const draft = validate(input.draft)
      current.current = {
        ...current.current,
        ...draft,
        payload: draft.payload,
        effectiveFrom: draft.effectiveFrom ?? null,
        effectiveUntil: draft.effectiveUntil ?? null,
        version: current.current.version + 1,
        revisionId: `fixture-revision-${current.current.version + 1}`,
      }
      setLedger(JSON.stringify(current.current, null, 2))
      return { version: current.current.version }
    }
    return {
      admin: {
        previewUniversalContent: {
          query: async (input: { draft: unknown }) => {
            const draft = validate(input.draft)
            return { preview: { lifecycle: 'EFFECTIVE', audience: draft.audience } }
          },
        },
        addUniversalContentRevision: {
          mutate: async (input: { draft: unknown; expectedLatestVersion: number }) => append(input),
        },
        retireUniversalContent: {
          mutate: async (input: { expectedLatestVersion: number; effectiveUntil: string }) => {
            const payload = { ...current.current.payload }
            delete payload.applicability
            return append({
              ...input,
              draft: {
                audience: current.current.audience,
                payload,
                effectiveUntil: input.effectiveUntil,
                evidence: [],
              },
            })
          },
        },
        publishUniversalContent: {
          mutate: async () => {
            setLedger(`MOCK PUBLISH ${current.current.revisionId}`)
            return { action: 'PUBLISH' }
          },
        },
      },
    } as unknown as DashboardTRPCClient
  }, [])
  return (
    <FixtureTRPCClientProvider client={client}>
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
        <header>
          <h1 className="text-2xl font-semibold text-pf-deep">
            Synthetic fact authoring and publication review
          </h1>
          <p className="mt-2 text-sm text-pf-deep">
            Real workbench, in-memory mock API. No database or publication occurs. Valid synthetic
            targets: module fixture-coat-check; place fixture-north-door.
          </p>
          <button
            type="button"
            className="mt-3 min-h-11 rounded-xl border border-pf-light px-4"
            onClick={() => setModules([{ ...current.current }])}
          >
            Load latest fixture state
          </button>
        </header>
        <GeneralizedContentWorkbench
          tenantId="fixture-tenant"
          venueId="fixture-venue"
          authoringEnabled
          initialCreationKey="527c3504-8e5a-4f43-9271-dc51e4e47dad"
          modules={modules}
        />
        <details>
          <summary className="min-h-11 cursor-pointer">Mock write receipt</summary>
          <pre className="whitespace-pre-wrap break-all text-xs">{ledger}</pre>
        </details>
      </main>
    </FixtureTRPCClientProvider>
  )
}
