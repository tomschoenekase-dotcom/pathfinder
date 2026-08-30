'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  LockKeyhole,
  MailCheck,
  Send,
  X,
} from 'lucide-react'

import { useTRPCClient } from '../../lib/trpc'

type Campaign = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['getProspectCampaign']['query']>
>
type Readiness = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['getProspectOutreachReadiness']['query']>
>
type Rehearsal = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['getProspectNoSendRehearsal']['query']>
>

export function ProspectCampaignWorkbench({
  campaignId,
  fixture,
}: {
  campaignId: string
  fixture?: { campaign: Campaign; readiness: Readiness; rehearsal?: Rehearsal }
}) {
  const client = useTRPCClient()
  const [campaign, setCampaign] = useState<Campaign | null>(fixture?.campaign ?? null)
  const [readiness, setReadiness] = useState<Readiness | null>(fixture?.readiness ?? null)
  const [rehearsal, setRehearsal] = useState<Rehearsal | null>(fixture?.rehearsal ?? null)
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set())
  const [editingMember, setEditingMember] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [providerAccountId, setProviderAccountId] = useState('')
  const [confirmation, setConfirmation] = useState<{
    action: 'approve' | 'release'
    batch: Campaign['sendBatches'][number]
  } | null>(null)
  const confirmationButtonRef = useRef<HTMLButtonElement>(null)
  const confirmationDialogRef = useRef<HTMLElement>(null)

  const refresh = useCallback(async () => {
    if (fixture) return
    const [next, ready, noSendRehearsal] = await Promise.all([
      client.admin.getProspectCampaign.query({ campaignId }),
      client.admin.getProspectOutreachReadiness.query(),
      client.admin.getProspectNoSendRehearsal.query({ campaignId }),
    ])
    setCampaign(next)
    setReadiness(ready)
    setRehearsal(noSendRehearsal)
  }, [campaignId, client, fixture])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (!providerAccountId && readiness?.accounts?.length === 1)
      setProviderAccountId(readiness.accounts[0]?.id ?? '')
  }, [providerAccountId, readiness])
  useEffect(() => {
    if (!confirmation) return
    confirmationButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmation(null)
      if (event.key === 'Tab') {
        const focusable = confirmationDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        if (!focusable?.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [confirmation])

  const counts = useMemo(
    () =>
      campaign?.members.reduce<Record<string, number>>((result, member) => {
        result[member.status] = (result[member.status] ?? 0) + 1
        return result
      }, {}) ?? {},
    [campaign],
  )
  const selectedProviderAccount = readiness?.accounts?.find(
    (account) => account.id === providerAccountId,
  )
  const selectedProviderReady = Boolean(
    selectedProviderAccount?.connectionStatus === 'CONNECTED' &&
    selectedProviderAccount.deliveryEnabled &&
    !selectedProviderAccount.pausedAt &&
    !selectedProviderAccount.healthErrorCode,
  )
  if (!campaign)
    return (
      <p role="status" className="p-10 text-center text-sm text-slate-500">
        Loading campaign…
      </p>
    )

  async function saveDraft(memberId: string) {
    setBusy(true)
    try {
      await client.admin.saveProspectOutreachDraft.mutate({
        memberId,
        subject,
        textBody: body,
        groundingSnapshot: {
          source: 'operator-workbench',
          campaignId,
          capturedAt: new Date().toISOString(),
        },
      })
      setEditingMember(null)
      setNotice('Draft saved for review')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function review(
    draft: NonNullable<Campaign['members'][number]['drafts'][number]>,
    approve: boolean,
  ) {
    setBusy(true)
    try {
      await client.admin.reviewProspectOutreachDraft.mutate({
        draftId: draft.id,
        approve,
        ...(approve
          ? { acknowledgedEscalations: draft.escalationFlags }
          : { reason: window.prompt('Why should this draft be revised?') ?? 'Revision requested' }),
      })
      setNotice(approve ? 'Draft approved and frozen' : 'Draft returned for revision')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function stageBatch() {
    setBusy(true)
    try {
      const batch = await client.admin.stageProspectSendBatch.mutate({
        campaignId,
        draftIds: [...selectedDrafts],
      })
      setSelectedDrafts(new Set())
      setNotice(`Staged a frozen batch of ${batch.recipientCount}`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function approveBatch(batch: Campaign['sendBatches'][number]) {
    setBusy(true)
    try {
      await client.admin.approveProspectSendBatch.mutate({
        batchId: batch.id,
        expectedRecipientCount: batch.recipientCount,
        expectedSnapshotHash: batch.snapshotHash,
      })
      setNotice('Batch approved. Nothing has been sent.')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function sendBatch(batch: Campaign['sendBatches'][number]) {
    if (!providerAccountId || !selectedProviderReady) return
    setBusy(true)
    try {
      const result = await client.admin.queueProspectSendBatch.mutate({
        batchId: batch.id,
        expectedRecipientCount: batch.recipientCount,
        expectedSnapshotHash: batch.snapshotHash,
        providerAccountId,
      })
      setNotice(
        `${result.pendingDispatch} frozen message${result.pendingDispatch === 1 ? '' : 's'} recorded in the transactional outbox; ${result.dispatched} dispatched`,
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/prospects/outreach"
          className="inline-flex items-center gap-2 text-sm font-semibold text-sky-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Outreach center
        </Link>
        <div className="mt-4 flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
              {campaign.playbookVersion}
            </p>
            <h1 className="mt-2 text-3xl font-bold text-slate-950">{campaign.name}</h1>
            <p className="mt-2 text-sm text-slate-600">
              Cohort and message content remain reviewable until approval; approved snapshots are
              immutable.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
            <strong className="text-slate-950">{campaign.members.length}</strong> recipients ·{' '}
            {counts.NEEDS_REVIEW ?? 0} need review · {counts.APPROVED ?? 0} approved ·{' '}
            {counts.SENT ?? 0} sent
          </div>
        </div>
      </div>
      {notice ? (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800"
        >
          {notice}
        </div>
      ) : null}

      {rehearsal ? (
        <section
          className={`rounded-2xl border p-5 shadow-sm ${
            rehearsal.readyForHumanReview
              ? 'border-emerald-300 bg-emerald-50'
              : 'border-amber-300 bg-amber-50'
          }`}
          aria-labelledby="no-send-rehearsal-heading"
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div className="flex gap-3">
              {rehearsal.readyForHumanReview ? (
                <CheckCircle2
                  className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700"
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-800"
                  aria-hidden="true"
                />
              )}
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-600">
                  Zero-send safety proof
                </p>
                <h2 id="no-send-rehearsal-heading" className="mt-1 font-semibold text-slate-950">
                  {rehearsal.readyForHumanReview
                    ? 'Ready for human review — never ready to send'
                    : 'No-send rehearsal found blockers'}
                </h2>
                <p className="mt-1 text-sm leading-6 text-slate-700">
                  This read-only rehearsal made {rehearsal.safety.providerCallsMade} provider calls
                  and cost ${rehearsal.safety.estimatedProviderCostUsd.toFixed(2)}. It cannot draft,
                  approve, queue, or release a message.
                </p>
              </div>
            </div>
            <span className="self-start rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 ring-1 ring-slate-200">
              {rehearsal.outcome.replaceAll('_', ' ')}
            </span>
          </div>

          <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Delivery', rehearsal.safety.deliveryDark ? 'Dark' : 'Enabled'],
              ['Scope', rehearsal.safety.internalOnly ? 'Internal only' : 'External allowed'],
              ['Contacts', `${rehearsal.cohort.memberCount} of ${rehearsal.cohort.maxCohort}`],
              ['Frozen recipients', String(rehearsal.frozenSnapshots.recipientCount)],
              ['Unsafe contacts', String(rehearsal.cohort.unsafeMemberCount)],
              ['Missing provenance', String(rehearsal.cohort.missingProvenanceCount)],
              ['Duplicate identities', String(rehearsal.frozenSnapshots.duplicateIdentityCount)],
              ['Drafts needing review', String(rehearsal.review.draftsNeedingReviewCount)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-black/5 bg-white/80 px-3 py-2.5">
                <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
                  {label}
                </dt>
                <dd className="mt-1 text-sm font-semibold text-slate-950">{value}</dd>
              </div>
            ))}
          </dl>

          {rehearsal.blockers.length ? (
            <div className="mt-4">
              <p className="text-xs font-bold text-amber-950">Resolve before human review:</p>
              <ul className="mt-2 flex flex-wrap gap-2" aria-label="No-send rehearsal blockers">
                {rehearsal.blockers.map((blocker) => (
                  <li
                    key={blocker}
                    className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-amber-900 ring-1 ring-amber-200"
                  >
                    {blocker.replaceAll('_', ' ').toLowerCase()}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="mt-4 text-xs text-slate-600">
            Emergency stop:{' '}
            {rehearsal.safety.emergencyStopDirection.toLowerCase().replace('_', ' ')}. Open
            organization duplicate candidates: {rehearsal.cohort.openOrganizationDuplicateCount}.
            Provider account not required for this rehearsal.
          </p>
        </section>
      ) : null}

      <section
        className="rounded-2xl border border-amber-300 bg-amber-50 p-5"
        aria-labelledby="delivery-safety-heading"
      >
        <h2 id="delivery-safety-heading" className="font-semibold text-amber-950">
          Prospect delivery is dark by default
        </h2>
        <p className="mt-1 text-sm leading-6 text-amber-900">
          Approval never sends. Final release remains unavailable unless the server kill switch,
          global control, and a healthy Gmail mailbox all allow delivery.
        </p>
        <label className="mt-4 block max-w-xl text-xs font-bold text-slate-800">
          Gmail mailbox for final release
          <select
            value={providerAccountId}
            onChange={(event) => setProviderAccountId(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal"
          >
            <option value="">Choose a connected mailbox</option>
            {readiness?.accounts?.map((account) => (
              <option
                key={account.id}
                value={account.id}
                disabled={
                  account.connectionStatus !== 'CONNECTED' ||
                  !account.deliveryEnabled ||
                  Boolean(account.pausedAt)
                }
              >
                {account.mailboxAddress} — {account.connectionStatus}
                {account.pausedAt ? ' (paused)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-3 grid gap-2 md:grid-cols-2" aria-label="Gmail mailbox health">
          {readiness?.accounts?.length ? (
            readiness.accounts.map((account) => (
              <article key={account.id} className="rounded-xl border border-amber-200 bg-white p-3">
                <p className="text-sm font-semibold text-slate-950">{account.mailboxAddress}</p>
                <p className="mt-1 text-xs text-slate-600">
                  {account.connectionStatus} · sync{' '}
                  {account.lastSuccessfulSyncAt
                    ? new Date(account.lastSuccessfulSyncAt).toLocaleString()
                    : 'never'}{' '}
                  · reconciliation{' '}
                  {account.lastReconciliationAt
                    ? new Date(account.lastReconciliationAt).toLocaleString()
                    : 'never'}
                </p>
                {account.healthErrorSummary ? (
                  <p role="alert" className="mt-2 text-xs font-semibold text-rose-700">
                    {account.healthErrorCode ? `${account.healthErrorCode}: ` : ''}
                    {account.healthErrorSummary}
                  </p>
                ) : null}
              </article>
            ))
          ) : (
            <p className="text-sm text-amber-900">No Gmail mailbox is connected.</p>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-semibold text-slate-950">Draft review queue</h2>
            <p className="mt-1 text-xs text-slate-500">
              Strategic, pricing, travel, scheduling, and custom commitments require explicit
              acknowledgment.
            </p>
          </div>
          <button
            disabled={!selectedDrafts.size || busy}
            onClick={() => void stageBatch()}
            className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            Stage {selectedDrafts.size || ''} approved draft{selectedDrafts.size === 1 ? '' : 's'}
          </button>
        </div>
        <ul className="divide-y divide-slate-100">
          {campaign.members.map((member) => {
            const draft = member.drafts[0]
            const editing = editingMember === member.id
            return (
              <li key={member.id} className="p-5">
                <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-slate-950">
                        {member.organization.canonicalName}
                      </h3>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">
                        {member.status}
                      </span>
                      <span className="rounded-full bg-violet-50 px-2 py-1 text-[10px] font-bold text-violet-700">
                        {member.organization.relationshipTier}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {member.contact?.fullName ?? 'No contact'} ·{' '}
                      {member.contact?.email ?? 'No verified email'} ·{' '}
                      {member.venue?.name ?? 'Organization level'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {draft?.status === 'APPROVED' ? (
                      <label className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">
                        <input
                          type="checkbox"
                          checked={selectedDrafts.has(draft.id)}
                          onChange={(event) =>
                            setSelectedDrafts((current) => {
                              const next = new Set(current)
                              if (event.target.checked) next.add(draft.id)
                              else next.delete(draft.id)
                              return next
                            })
                          }
                        />
                        Include in batch
                      </label>
                    ) : null}
                    {draft?.status === 'NEEDS_REVIEW' ? (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => void review(draft, false)}
                          className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold"
                        >
                          Request revision
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => void review(draft, true)}
                          className="rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white"
                        >
                          Approve + freeze
                        </button>
                      </>
                    ) : null}
                    {!draft || ['REJECTED', 'SUPERSEDED'].includes(draft.status) ? (
                      <button
                        onClick={() => {
                          setEditingMember(member.id)
                          setSubject(
                            `Torchiko for ${member.venue?.name ?? member.organization.canonicalName}`,
                          )
                          setBody('')
                        }}
                        disabled={!member.contact?.email || member.contact.doNotContact}
                        className="rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                      >
                        Write draft
                      </button>
                    ) : null}
                  </div>
                </div>
                {draft && !editing ? (
                  <article className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-bold text-slate-500">
                        v{draft.version} · {draft.status}
                      </p>
                      {draft.escalationFlags.length ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-800">
                          <AlertTriangle className="h-3 w-3" />
                          {draft.escalationFlags.join(', ')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700">
                          <CheckCircle2 className="h-3 w-3" />
                          No escalation flags
                        </span>
                      )}
                    </div>
                    <p className="mt-3 text-sm font-semibold text-slate-900">{draft.subject}</p>
                    <div
                      role="region"
                      aria-label={`Draft message body for ${member.organization.canonicalName}`}
                      tabIndex={0}
                      className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg text-sm leading-6 text-slate-600 outline-none focus-visible:ring-2 focus-visible:ring-slate-950 focus-visible:ring-offset-2"
                    >
                      {draft.textBody}
                    </div>
                  </article>
                ) : null}
                {editing ? (
                  <div className="mt-4 space-y-3 rounded-xl border border-sky-200 bg-sky-50 p-4">
                    <label className="block text-xs font-bold text-slate-700">
                      Subject
                      <input
                        value={subject}
                        onChange={(event) => setSubject(event.target.value)}
                        className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal"
                      />
                    </label>
                    <label className="block text-xs font-bold text-slate-700">
                      Email body
                      <textarea
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                        rows={10}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm font-normal leading-6"
                      />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditingMember(null)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold"
                      >
                        Cancel
                      </button>
                      <button
                        disabled={busy || !subject.trim() || !body.trim()}
                        onClick={() => void saveDraft(member.id)}
                        className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                      >
                        Save for review
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-5 w-5 text-slate-700" />
          <h2 className="font-semibold text-slate-950">Frozen send batches</h2>
        </div>
        {!campaign.sendBatches.length ? (
          <p className="mt-4 text-sm text-slate-500">
            No batch staged. Approve drafts and select them above.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {campaign.sendBatches.map((batch) => (
              <li key={batch.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div>
                    <p className="text-sm font-semibold text-slate-950">
                      {batch.recipientCount} recipients · {batch.status}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-slate-600">
                      {batch.snapshotHash.slice(0, 20)}…
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {batch.status === 'STAGED' ? (
                      <button
                        disabled={busy}
                        onClick={() => setConfirmation({ action: 'approve', batch })}
                        className="inline-flex items-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white"
                      >
                        <MailCheck className="h-4 w-4" />
                        Approve exact batch
                      </button>
                    ) : null}
                    {batch.status === 'APPROVED' ? (
                      <button
                        disabled={
                          busy ||
                          !readiness?.deliveryEnabled ||
                          !readiness.providerConfigured ||
                          !selectedProviderReady
                        }
                        onClick={() => setConfirmation({ action: 'release', batch })}
                        title={
                          !readiness?.deliveryEnabled
                            ? 'Delivery is disabled by configuration'
                            : !selectedProviderReady
                              ? 'Choose a connected, unpaused, healthy Gmail mailbox'
                              : undefined
                        }
                        className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Send className="h-4 w-4" />
                        Send now
                      </button>
                    ) : null}
                  </div>
                </div>
                <details className="mt-3 border-t border-slate-100 pt-3">
                  <summary className="cursor-pointer text-xs font-bold text-sky-800">
                    Inspect exact frozen recipients and content
                  </summary>
                  <ul className="mt-3 space-y-3">
                    {batch.items.map((item) => (
                      <li key={item.id} className="rounded-lg bg-slate-50 p-3">
                        <p className="break-all text-xs font-bold text-slate-900">
                          To: {item.recipientEmailSnapshot}
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {item.subjectSnapshot}
                        </p>
                        <p className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-700">
                          {item.textBodySnapshot}
                        </p>
                        <p className="mt-2 break-all font-mono text-[10px] text-slate-500">
                          content {item.contentHashSnapshot}
                        </p>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      {confirmation ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setConfirmation(null)
          }}
        >
          <section
            ref={confirmationDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="batch-confirmation-title"
            aria-describedby="batch-confirmation-description"
            className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="batch-confirmation-title" className="text-lg font-bold text-slate-950">
                  {confirmation.action === 'approve'
                    ? 'Approve this exact frozen batch?'
                    : 'Final release of this exact batch?'}
                </h2>
                <p id="batch-confirmation-description" className="mt-1 text-sm text-slate-600">
                  Exact count: {confirmation.batch.recipientCount}. Snapshot:{' '}
                  <span className="font-mono text-xs">{confirmation.batch.snapshotHash}</span>
                </p>
                {confirmation.action === 'release' ? (
                  <p className="mt-2 text-sm font-semibold text-rose-800">
                    Gmail mailbox: {selectedProviderAccount?.mailboxAddress ?? 'none selected'}
                  </p>
                ) : null}
              </div>
              <button
                ref={confirmationButtonRef}
                type="button"
                onClick={() => setConfirmation(null)}
                aria-label="Close confirmation"
                className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <ul className="mt-4 max-h-64 space-y-2 overflow-auto" aria-label="Frozen recipients">
              {confirmation.batch.items.map((item) => (
                <li key={item.id} className="rounded-lg border border-slate-200 p-3">
                  <p className="break-all text-xs font-bold">{item.recipientEmailSnapshot}</p>
                  <p className="mt-1 truncate text-sm text-slate-700">{item.subjectSnapshot}</p>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirmation(null)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const pending = confirmation
                  setConfirmation(null)
                  if (pending.action === 'approve') void approveBatch(pending.batch)
                  else void sendBatch(pending.batch)
                }}
                className={`rounded-xl px-4 py-2.5 text-sm font-bold text-white ${
                  confirmation.action === 'approve' ? 'bg-emerald-700' : 'bg-rose-700'
                }`}
              >
                {confirmation.action === 'approve'
                  ? `Approve ${confirmation.batch.recipientCount}; do not send`
                  : `Release ${confirmation.batch.recipientCount} through Gmail`}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
