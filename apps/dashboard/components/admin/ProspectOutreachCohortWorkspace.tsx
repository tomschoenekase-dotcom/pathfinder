'use client'
import { useEffect, useRef, useState } from 'react'
import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import {
  ProspectOutreachReviewDocument,
  type OutreachReviewDocument,
} from './ProspectOutreachReviewDocument'

export function ProspectOutreachCohortWorkspace() {
  const trpc = useTRPCClient()
  const [groups, setGroups] = useState<{ cohortId: string; name: string; count: number }[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [id, setId] = useState(''),
    [review, setReview] = useState<OutreachReviewDocument | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState('')
  const [confirmedRead, setConfirmedRead] = useState(false)
  const groupRequest = useRef(false),
    operation = useRef(false)
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [groupsError, setGroupsError] = useState('')
  const [reason, setReason] = useState('')
  const [pendingControl, setPendingControl] = useState<{
    cohortId: string
    requestKey: string
    expectedReviewHash: string
    action: 'pause' | 'resume' | 'cancel'
    reason: string
  } | null>(null)
  async function loadGroups(cursor?: string) {
    if (groupRequest.current) return
    groupRequest.current = true
    setGroupsLoading(true)
    setGroupsError('')
    try {
      const result = await runBoundedClientRequest({
        parentSignal: new AbortController().signal,
        timeoutMs: 15000,
        request: (signal) =>
          trpc.admin.listProspectOutreachCohorts.query(
            { limit: 25, ...(cursor ? { cursor } : {}) },
            { signal },
          ),
      })
      setGroups((previous) => [
        ...new Map(
          (cursor ? [...previous, ...result.items] : result.items).map((group) => [
            group.cohortId,
            group,
          ]),
        ).values(),
      ])
      setNextCursor(result.nextCursor)
    } catch (cause) {
      setGroupsError(
        cause instanceof Error
          ? cause.message
          : 'Native group listing is unavailable; this is not an empty list.',
      )
    } finally {
      groupRequest.current = false
      setGroupsLoading(false)
    }
  }
  useEffect(() => {
    void loadGroups()
  }, [])
  async function open(cohortId: string) {
    if (operation.current || !cohortId.trim()) return
    operation.current = true
    setBusy(true)
    setError('')
    setReceipt('')
    setConfirmedRead(false)
    setReview(null)
    setId(cohortId)
    setPendingControl(null)
    setReason('')
    try {
      setReview(
        await runBoundedClientRequest({
          parentSignal: new AbortController().signal,
          timeoutMs: 15000,
          request: (signal) =>
            trpc.admin.readProspectOutreachCohort.query({ cohortId }, { signal }),
        }),
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Exact native review is unavailable. No empty review was substituted.',
      )
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  async function acknowledge() {
    if (!review || !confirmedRead || operation.current) return
    operation.current = true
    setBusy(true)
    setError('')
    try {
      const result = await trpc.admin.acknowledgeProspectOutreachReview.mutate({
        cohortId: review.cohortId,
        expectedReviewHash: review.reviewHash,
        expectedCount: review.count,
        acknowledgement: 'I reviewed these exact messages and holds. This is not sending approval.',
      })
      setReceipt(
        `Read acknowledgement retained: ${result.receiptId}. No meaning or send approval was created.`,
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Response was not confirmed. Retry this exact fingerprint before refreshing.',
      )
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  async function control(action: 'pause' | 'resume' | 'cancel') {
    if (!review || operation.current || (!pendingControl && reason.trim().length < 12)) return
    operation.current = true
    setBusy(true)
    setError('')
    setReceipt('')
    const input = pendingControl ?? {
      cohortId: review.cohortId,
      requestKey: crypto.randomUUID(),
      expectedReviewHash: review.reviewHash,
      action,
      reason: reason.trim(),
    }
    setPendingControl(input)
    try {
      const result = await trpc.admin.controlProspectOutreachCohort.mutate(input)
      setPendingControl(null)
      setReason('')
      setConfirmedRead(false)
      setReceipt(
        `Preparation state retained: ${String(result.status)}. Receipt ${String(result.receiptId)}. All selections and drafts remain; this group stays excluded from another group.`,
      )
      try {
        setReview(
          await runBoundedClientRequest({
            parentSignal: new AbortController().signal,
            timeoutMs: 15000,
            request: (signal) =>
              trpc.admin.readProspectOutreachCohort.query({ cohortId: input.cohortId }, { signal }),
          }),
        )
      } catch {
        setReview(null)
        setError(
          'The state-change receipt was confirmed, but the current review could not be reopened. Open the group again; do not repeat the state change.',
        )
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'State-change response is unknown. Retry the same retained request before making another change.',
      )
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-5">
        <h2 className="text-lg font-semibold">Resume a native preparation group</h2>
        <p className="mt-1 text-sm">
          Ask the connected outreach agent to preview and reserve up to 50 exact venues. Groups
          survive fresh chats, and another group excludes all earlier selections.
        </p>
        <form
          className="mt-4 flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            void open(id.trim())
          }}
        >
          <input
            className="min-w-0 flex-1 rounded border px-3 py-2"
            aria-label="Native preparation cohort ID"
            placeholder="Paste a native cohort ID"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
          <button
            className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            disabled={busy || !id.trim()}
          >
            Open exact review
          </button>
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          {groups.map((group) => (
            <button
              key={group.cohortId}
              disabled={busy}
              className="rounded border px-3 py-2 text-left text-sm"
              onClick={() => void open(group.cohortId)}
            >
              {group.name} · {group.count} records
            </button>
          ))}
        </div>
        {nextCursor && (
          <button
            disabled={groupsLoading}
            className="mt-3 min-h-11 text-sm underline disabled:opacity-50"
            onClick={() => void loadGroups(nextCursor)}
          >
            Load the next retained groups
          </button>
        )}
        {groupsLoading && (
          <p role="status" className="mt-3 text-sm">
            Loading retained preparation groups…
          </p>
        )}
        {groupsError && (
          <p role="alert" className="mt-3 text-sm">
            {groupsError}{' '}
            <button
              className="min-h-11 underline"
              onClick={() => void loadGroups(nextCursor ?? undefined)}
            >
              Retry group listing
            </button>
          </p>
        )}
        {groups.length === 0 && !groupsLoading && !groupsError && (
          <p className="mt-3 text-sm">No preparation group was returned by this native listing.</p>
        )}
      </section>
      {busy && <p role="status">Reading the native source-bound records…</p>}
      {error && (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-4">
          {error}
        </p>
      )}
      {review && (
        <>
          <ProspectOutreachReviewDocument review={review} />
          <section className="rounded-lg border bg-white p-5">
            <label className="flex gap-3">
              <input
                type="checkbox"
                checked={confirmedRead}
                onChange={(event) => setConfirmedRead(event.target.checked)}
              />
              <span>
                I read all {review.count} exact messages and unfinished or held records shown above.
                This is not permission to send.
              </span>
            </label>
            <button
              className="mt-4 rounded border px-4 py-2 disabled:opacity-50"
              disabled={!confirmedRead || busy}
              onClick={() => void acknowledge()}
            >
              Record this exact read acknowledgement
            </button>
            <p className="mt-3 text-sm">
              Meaning review and later exact-message approval stay in the native per-venue workflow.
              There is no send or delivery-enablement control here.
            </p>
            <div className="mt-6 border-t pt-5">
              <h3 className="font-semibold">Pause or stop this preparation</h3>
              <p className="mt-2 text-sm">
                These controls preserve every selected record and existing draft. Cancelling does
                not erase history or make the same venues eligible for “50 more.” Resuming still
                rechecks each held record.
              </p>
              <label className="mt-3 block text-sm" htmlFor="outreach-control-reason">
                Reason for this preparation-state change
              </label>
              <textarea
                id="outreach-control-reason"
                className="mt-2 min-h-24 w-full rounded border p-3"
                maxLength={2000}
                value={reason}
                disabled={busy || Boolean(pendingControl)}
                onChange={(event) => setReason(event.target.value)}
              />
              <div className="mt-3 flex flex-wrap gap-3">
                {pendingControl ? (
                  <button
                    className="min-h-11 rounded border px-4 py-2"
                    disabled={busy}
                    onClick={() => void control(pendingControl.action)}
                  >
                    Retry the exact {pendingControl.action} request
                  </button>
                ) : (
                  (['pause', 'cancel', 'resume'] as const).map((action) => (
                    <button
                      key={action}
                      className="min-h-11 rounded border px-4 py-2 disabled:opacity-50"
                      disabled={busy || reason.trim().length < 12}
                      onClick={() => void control(action)}
                    >
                      {action === 'pause'
                        ? 'Pause preparation'
                        : action === 'cancel'
                          ? 'Cancel preparation, keep history'
                          : 'Resume preparation'}
                    </button>
                  ))
                )}
              </div>
            </div>
          </section>
        </>
      )}
      {receipt && (
        <p role="status" className="rounded border border-emerald-300 bg-emerald-50 p-4">
          {receipt}
        </p>
      )}
    </div>
  )
}
