'use client'
import { useId, useState } from 'react'
import type { SalesWorkflowView, NativeSalesAction } from '@pathfinder/api/prospect-sales-contract'
const button =
  'min-h-11 rounded-md border border-slate-400 px-4 py-2 text-sm font-semibold text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 hover:bg-slate-100 disabled:opacity-50'
const field =
  'mt-2 block min-h-11 w-full min-w-0 rounded-md border border-slate-400 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700'
export function ProspectOperationalHandoff({
  view,
  enabled,
  onAction,
}: {
  view: SalesWorkflowView
  enabled: boolean
  onAction: (action: NativeSalesAction) => Promise<void>
}) {
  const id = useId(),
    [accountId, setAccount] = useState(''),
    [name, setName] = useState(''),
    [ack, setAck] = useState<string[]>([])
  const op = view.operational,
    candidate = op?.candidate,
    batch = candidate?.batch
  if (!op) return null
  const currentMeaning = view.claimReview?.current
  const eligibleMeaning = Boolean(
    view.draft &&
    currentMeaning &&
    view.claimReview?.status === 'ASSESSED_NO_SEND' &&
    !view.claimReview.stale,
  )
  const readyContact = view.routing?.kind === 'email' && view.routing.readiness === 'VALID'
  const common = { venueId: view.venueId, expectedSnapshotHash: view.snapshotHash }
  const actionEnabled = enabled && !candidate?.staleReason
  return (
    <section
      aria-label="Operational candidate handoff"
      className="mt-6 min-w-0 border-t-2 border-slate-300 pt-5"
    >
      <h3 className="text-base font-bold text-slate-950">Separate operational candidate</h3>
      <p className="mt-2 text-sm leading-6 text-slate-700">
        The original preparation stays immutable and NO-SEND. An explicit selection creates a new
        candidate in the existing campaign and approval system, retaining its exact source, text,
        model attribution and assessment.
      </p>
      <p className="mt-2 text-sm font-semibold leading-6 text-amber-950">
        {op.rehearsal
          ? 'SYNTHETIC REHEARSAL: SYSTEM approval fixtures are not Tom approval. Only the isolated FAKE provider can be used.'
          : 'Live sending is not available through this local review page. A connected operational instance and Tom’s exact message authorization are still required.'}
      </p>
      {!readyContact ? (
        <p className="mt-2 text-sm leading-6 text-amber-950">
          Contact held: UNKNOWN or unresolved/form routing cannot be promoted to VALID by this
          handoff. Use the existing contact-readiness owner with genuine evidence.
        </p>
      ) : null}
      <details className="mt-3" open={!candidate}>
        <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
          Select this exact reviewed message for a new operational candidate
        </summary>
        <label htmlFor={`${id}-account`} className="mt-3 block text-sm font-semibold">
          Existing delivery account
        </label>
        <select
          id={`${id}-account`}
          value={accountId}
          onChange={(e) => setAccount(e.target.value)}
          disabled={!enabled}
          className={field}
        >
          <option value="">Select an account explicitly</option>
          {op.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.provider} · {a.mailbox} · {a.connected ? 'connected' : 'disconnected'}
              {a.provider === 'FAKE' ? ' · synthetic only' : ''}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-name`} className="mt-4 block text-sm font-semibold">
          Single-prospect campaign name
        </label>
        <input
          id={`${id}-name`}
          maxLength={160}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!enabled}
          className={field}
        />
        <button
          type="button"
          className={`${button} mt-4`}
          disabled={!enabled || !eligibleMeaning || !readyContact || !accountId || !name.trim()}
          onClick={() =>
            view.draft &&
            currentMeaning &&
            void onAction({
              action: 'handoffOperational',
              input: {
                ...common,
                draftId: view.draft.id,
                contentHash: view.draft.contentHash,
                meaningReviewId: currentMeaning.id,
                providerAccountId: accountId,
                campaignName: name,
              },
            })
          }
        >
          Create separate operational candidate
        </button>
      </details>
      {candidate ? (
        <div className="mt-5 min-w-0 border-l-2 border-slate-300 pl-4 text-sm leading-6">
          <p className="font-semibold">
            {candidate.synthetic ? 'SYNTHETIC operational candidate' : 'Operational candidate'} ·{' '}
            {candidate.status.replaceAll('_', ' ')}
          </p>
          <p className="mt-2 break-all">
            <strong>To:</strong> {candidate.recipient}
          </p>
          <p>
            <strong>Subject:</strong> {candidate.subject}
          </p>
          <p className="mt-2 whitespace-pre-wrap">{candidate.body}</p>
          <p className="mt-3">
            <strong>
              Generated by{' '}
              {candidate.generatedByKind === 'AGENT'
                ? 'AI agent/model'
                : candidate.generatedByKind.toLowerCase()}
              :
            </strong>{' '}
            {candidate.generatedBy}
          </p>
          <p>
            <strong>
              {candidate.synthetic ? 'Synthetic fixture approver' : 'Human approver'}:
            </strong>{' '}
            {candidate.approvedBy ?? 'ABSENT'}
          </p>
          <p className="mt-2 break-all text-xs">
            Content SHA-256: {candidate.contentHash}
            <br />
            Source draft: {candidate.sourceDraftId}
            <br />
            Source assessment: {candidate.meaningReviewId}
          </p>
          {candidate.staleReason ? (
            <p className="mt-3 border-l-4 border-amber-700 bg-amber-50 p-3 text-sm">
              HOLD: {candidate.staleReason}
            </p>
          ) : null}
          {candidate.status === 'NEEDS_REVIEW' ? (
            <>
              {candidate.escalationFlags.map((flag) => (
                <label key={flag} className="mt-2 flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={ack.includes(flag)}
                    onChange={(e) =>
                      setAck(e.target.checked ? [...ack, flag] : ack.filter((v) => v !== flag))
                    }
                  />
                  Acknowledge exact escalation: {flag}
                </label>
              ))}
              <button
                type="button"
                className={`${button} mt-4`}
                disabled={
                  !actionEnabled || candidate.escalationFlags.some((flag) => !ack.includes(flag))
                }
                onClick={() =>
                  void onAction({
                    action: 'reviewOperational',
                    input: {
                      ...common,
                      draftId: candidate.id,
                      expectedContentHash: candidate.contentHash,
                      acknowledgedEscalations: ack,
                    },
                  })
                }
              >
                {candidate.synthetic
                  ? 'Record synthetic exact approval'
                  : 'Approve this exact operational candidate'}
              </button>
            </>
          ) : null}
          {candidate.status === 'APPROVED' && !batch ? (
            <button
              type="button"
              className={`${button} mt-4`}
              disabled={!actionEnabled}
              onClick={() =>
                void onAction({
                  action: 'stageOperational',
                  input: {
                    ...common,
                    draftId: candidate.id,
                    campaignId: candidate.campaignId,
                    expectedContentHash: candidate.contentHash,
                  },
                })
              }
            >
              Freeze this one-recipient batch
            </button>
          ) : null}
          {batch ? (
            <div className="mt-4 border-t border-slate-200 pt-3">
              <p>
                <strong>Frozen recipient count:</strong> {batch.count} · {batch.status}
              </p>
              <p className="break-all text-xs">Frozen snapshot SHA-256: {batch.hash}</p>
              <p className="mt-2">
                <strong>Delivery owner state:</strong> {batch.deliveryState}
              </p>
              <p className="break-all">
                <strong>Provider message ID:</strong>{' '}
                {batch.providerMessageId ?? 'Absent — CRM must not claim acceptance'}
              </p>
              {batch.error ? (
                <p className="text-amber-950">
                  HOLD: {batch.error}. An ambiguous acceptance requires reconciliation, not blind
                  retry.
                </p>
              ) : null}
              {batch.status === 'STAGED' ? (
                <button
                  type="button"
                  className={`${button} mt-3`}
                  disabled={!actionEnabled || batch.count !== 1}
                  onClick={() =>
                    void onAction({
                      action: 'approveOperationalBatch',
                      input: {
                        ...common,
                        batchId: batch.id,
                        expectedRecipientCount: 1,
                        expectedBatchHash: batch.hash,
                      },
                    })
                  }
                >
                  {candidate.synthetic
                    ? 'Approve synthetic frozen count and content'
                    : 'Approve frozen count and content'}
                </button>
              ) : null}
              {batch.status === 'APPROVED' && candidate.synthetic && op.rehearsal ? (
                <button
                  type="button"
                  className={`${button} mt-3`}
                  disabled={!actionEnabled}
                  onClick={() =>
                    void onAction({
                      action: 'releaseSyntheticBatch',
                      input: {
                        ...common,
                        batchId: batch.id,
                        expectedRecipientCount: 1,
                        expectedBatchHash: batch.hash,
                        providerAccountId: candidate.providerAccountId,
                      },
                    })
                  }
                >
                  Release to isolated FAKE outbox
                </button>
              ) : null}
              {batch.outboxId ? (
                <p className="mt-2 break-all text-xs">
                  Existing outbox operation: {batch.outboxId}. Rehearsal dispatch uses the existing
                  foreground worker handler; no background queue or mailbox is enabled.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {op.correspondence.length ? (
        <details className="mt-4" open>
          <summary className="min-h-11 cursor-pointer py-3 font-semibold">
            Canonical correspondence and provider identity
          </summary>
          {op.correspondence.map((m) => (
            <div key={m.id} className="border-t border-slate-200 py-3 text-sm leading-6">
              <p className="font-semibold">
                {m.direction} · {m.subject}
              </p>
              <p>{m.preview ?? 'Body not retained; use original provider source.'}</p>
              <p className="break-all text-xs">
                Thread {m.threadId}
                <br />
                Provider message {m.providerMessageId ?? 'missing'}
                <br />
                {m.sourceReference}
              </p>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  )
}
