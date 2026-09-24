'use client'

import { useId, useState } from 'react'
import type {
  EvidenceAdmissionView,
  NativeSalesAction,
  SalesWorkflowView,
} from '@pathfinder/api/prospect-sales-contract'

const field =
  'mt-2 block min-h-11 w-full min-w-0 rounded-md border border-slate-400 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:bg-slate-100'
const button =
  'min-h-11 rounded-md border border-slate-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:cursor-not-allowed disabled:opacity-50'

export function ProspectEvidenceAdmission({
  view,
  evidence,
  enabled,
  onAction,
}: {
  view: SalesWorkflowView
  evidence: EvidenceAdmissionView
  enabled: boolean
  onAction: (action: NativeSalesAction) => Promise<void>
}) {
  const id = useId()
  const [captureId, setCaptureId] = useState(
    evidence.selection?.captureId ?? evidence.captures[0]?.id ?? '',
  )
  const [claimIds, setClaimIds] = useState(evidence.selection?.selection.claimIds ?? [])
  const [routeId, setRouteId] = useState(evidence.selection?.selection.routeClaimId ?? '')
  const [purpose, setPurpose] = useState(
    evidence.selection?.selection.purpose ??
      'Discuss whether a small venue-controlled visitor guide would be useful.',
  )
  const [hypothesis, setHypothesis] = useState(
    evidence.selection?.selection.hypothesis ??
      'Propose exploring a small guide using material the venue chooses. This is a discussion, not a deployment, price, visit or promised result.',
  )
  const capture = evidence.captures.find((c) => c.id === captureId)
  const canAdmit =
    enabled &&
    capture &&
    purpose.trim().length >= 12 &&
    hypothesis.trim().length >= 12 &&
    claimIds.length <= 8
  return (
    <section
      aria-label="Native evidence admission"
      className="mt-6 min-w-0 border-t-2 border-slate-700 pt-5"
    >
      <h3 className="text-lg font-semibold text-slate-950">Native source evidence</h3>
      <p className="mt-2 text-sm leading-6 text-slate-700">
        Inspect retained official-page captures, then select the exact claims and route for this
        message. A capture is attributed evidence, not authenticated human verification. Import
        candidates remain UNKNOWN.
      </p>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        No pasted facts, caller “verified” flags, website fetches or contact permission changes are
        accepted here.
      </p>
      {!evidence.captures.length ? (
        <p className="mt-3 border-l-4 border-amber-600 bg-amber-50 p-3 text-sm text-amber-950">
          No native official-page capture has been retained. The bounded questions above remain
          unresolved; an explicitly authorized source producer must supply actual captured evidence
          first.
        </p>
      ) : (
        <fieldset disabled={!enabled} className="mt-4 min-w-0">
          <legend className="text-sm font-bold">Source selection for this task</legend>
          <label htmlFor={`${id}-capture`} className="mt-3 block text-sm font-semibold">
            Retained native capture
          </label>
          <select
            id={`${id}-capture`}
            className={field}
            value={captureId}
            onChange={(event) => {
              setCaptureId(event.target.value)
              setClaimIds([])
              setRouteId('')
            }}
          >
            {evidence.captures.map((c) => (
              <option key={c.id} value={c.id}>
                {c.identity.name} · {c.id.slice(-12)}
              </option>
            ))}
          </select>
          {capture ? (
            <>
              <p className="mt-3 text-sm font-semibold">
                {capture.identity.name} · {capture.identity.city}, {capture.identity.region}
              </p>
              <p className="mt-1 break-all text-xs text-slate-600">
                Native venue: {capture.identity.venueId} · original import:{' '}
                {capture.identity.sourceLocator}
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-600">
                Producer: {capture.provenance.producer}
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {capture.provenance.associationReason}
              </p>
              <details className="mt-2 text-sm">
                <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                  Captured source provenance
                </summary>
                {capture.pages.map((page) => (
                  <div
                    key={page.id}
                    className="min-w-0 border-t border-slate-200 py-3 text-xs leading-5"
                  >
                    <p className="break-all font-semibold">
                      {page.id} · {page.url}
                    </p>
                    <p>Observed: {page.observedAt}</p>
                    <p>Retrieved: {page.retrievedAt}</p>
                    <p className="break-all">Exact captured bytes SHA-256: {page.rawSha256}</p>
                    <p>
                      Identity quote: {page.nameQuote}
                      {page.locationQuote
                        ? ` · ${page.locationQuote}`
                        : ' · directly linked identity page'}
                    </p>
                  </div>
                ))}
                <p className="break-all text-xs leading-5">
                  Pre-capture Research Gate plan: {capture.provenance.gatePlanId}
                </p>
              </details>
              <fieldset className="mt-3 min-w-0">
                <legend className="text-sm font-bold">Claims allowed in this message</legend>
                <p className="mt-2 text-xs leading-5 text-slate-600">
                  Choose only factual claims the writer should use. The original Gate also checks
                  required identity, official site and general fit context; unused optional claims
                  do not trigger freshness research.
                </p>
                {capture.claims
                  .filter((c) => !['public_route', 'official_site'].includes(c.kind))
                  .map((claim) => (
                    <div
                      key={claim.claimId}
                      className="mt-3 min-w-0 border-t border-slate-200 pt-2"
                    >
                      <label className="flex min-h-11 items-start gap-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          aria-label={`Admit claim ${claim.claimId}`}
                          className="mt-1 h-5 w-5 shrink-0"
                          checked={claimIds.includes(claim.claimId)}
                          onChange={(event) =>
                            setClaimIds((old) =>
                              event.target.checked
                                ? [...old, claim.claimId]
                                : old.filter((x) => x !== claim.claimId),
                            )
                          }
                        />
                        <span>
                          <span className="block font-semibold">
                            {claim.claimId} · {claim.kind.replaceAll('_', ' ')}
                          </span>
                          <span className="mt-1 block leading-6">{claim.value}</span>
                        </span>
                      </label>
                      <details className="ml-8 text-xs leading-5 text-slate-600">
                        <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                          Capture support: {claim.claimId}
                        </summary>
                        <blockquote className="border-l-2 border-slate-300 pl-3">
                          {claim.quote}
                        </blockquote>
                        <p className="mt-2">
                          {claim.pageId} · normalized text code points [{claim.start}, {claim.end})
                        </p>
                        <p>{claim.reason}</p>
                        {claim.validUntil ? (
                          <p>Explicit validity ends: {claim.validUntil}</p>
                        ) : null}
                      </details>
                    </div>
                  ))}
              </fieldset>
              <label htmlFor={`${id}-route`} className="mt-4 block text-sm font-semibold">
                Selected public route
              </label>
              <select
                id={`${id}-route`}
                className={field}
                value={routeId}
                onChange={(event) => setRouteId(event.target.value)}
              >
                <option value="">Unresolved — do not choose a recipient</option>
                {capture.claims
                  .filter((c) => c.kind === 'public_route')
                  .map((c) => (
                    <option value={c.claimId} key={c.claimId}>
                      {c.routeKind} · {c.value}
                    </option>
                  ))}
              </select>
              <p className="mt-2 text-xs leading-5 text-slate-600">
                An email remains a public snapshot; a form remains a URL. Neither is consent,
                deliverability or purchasing authority.
              </p>
              <label htmlFor={`${id}-purpose`} className="mt-4 block text-sm font-semibold">
                Message purpose
              </label>
              <textarea
                id={`${id}-purpose`}
                className={field}
                rows={2}
                maxLength={500}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
              />
              <label htmlFor={`${id}-hypothesis`} className="mt-4 block text-sm font-semibold">
                Proposal / task direction, not a source fact
              </label>
              <textarea
                id={`${id}-hypothesis`}
                className={field}
                rows={3}
                maxLength={1000}
                value={hypothesis}
                onChange={(event) => setHypothesis(event.target.value)}
              />
              <button
                type="button"
                className={`${button} mt-4`}
                disabled={!canAdmit}
                onClick={() => {
                  if (!canAdmit) return
                  void onAction({
                    action: 'admitEvidence',
                    input: {
                      venueId: view.venueId,
                      expectedSnapshotHash: view.snapshotHash,
                      expectedSelectionId: evidence.selectionId,
                      captureId,
                      selection: { claimIds, routeClaimId: routeId || null, purpose, hypothesis },
                    },
                  })
                }}
              >
                Admit selected evidence for review
              </button>
            </>
          ) : null}
        </fieldset>
      )}
      {evidence.selectionId ? (
        <p className="mt-3 break-all text-xs leading-5 text-slate-600">
          Immutable task selection: {evidence.selectionId}. Changing selected evidence requires a
          new preparation and exact-draft assessment; historical reviews are retained.
        </p>
      ) : null}
      {evidence.holds.length ? (
        <div className="mt-3 border-l-4 border-amber-600 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          <h4 className="font-bold">Evidence is retained but this task remains held</h4>
          {evidence.holds.map((hold, i) => (
            <p key={i} className="mt-2">
              {hold}
            </p>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-xs font-bold">
        SOURCE SELECTION IS NOT APPROVAL. SEND AUTHORIZED: NO.
      </p>
    </section>
  )
}
