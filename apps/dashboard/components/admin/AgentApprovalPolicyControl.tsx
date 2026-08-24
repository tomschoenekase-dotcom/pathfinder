'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState, type FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Policy = {
  id: string
  policyKey: string | null
  actionName: string
  capability: string
  issueReason: string | null
  maxUses: number | null
  useCount: number
  expiresAt: Date | null
  revokedAt: Date | null
  revokeReason: string | null
  state: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'EXHAUSTED' | 'SCHEDULED'
  constraints: unknown
  _count: { consumptions: number }
  authorityEvidence: Array<{ createdAt: Date; outcomeObservation: OutcomeObservation }>
}

type OutcomeObservation = {
  id: string
  agentRunId: string
  signalKind: string
  verdict: string
  summary: string
  evidenceRef: string | null
  taskClass: string
  modelProvider: string | null
  modelName: string | null
  createdAt: Date
}

function policyLimits(constraints: unknown) {
  if (!constraints || typeof constraints !== 'object') return null
  const value = constraints as Record<string, unknown>
  if (
    value.contractVersion !== 1 ||
    (value.effect !== 'DRAFT_ONLY' &&
      value.effect !== 'PROPOSAL_ONLY' &&
      value.effect !== 'DRAFT_GENERATION_ONLY')
  )
    return null
  if (typeof value.maxTitleChars === 'number' && typeof value.maxBodyChars === 'number')
    return {
      heading: 'Title',
      maxHeadingChars: value.maxTitleChars,
      maxBodyChars: value.maxBodyChars,
    }
  if (typeof value.maxSubjectChars === 'number' && typeof value.maxBodyChars === 'number')
    return {
      heading: 'Subject',
      maxHeadingChars: value.maxSubjectChars,
      maxBodyChars: value.maxBodyChars,
    }
  if (typeof value.maxNotesChars === 'number')
    return { heading: 'Notes', maxHeadingChars: value.maxNotesChars, maxBodyChars: null }
  if (typeof value.maxTitleChars === 'number' && typeof value.maxRangeDays === 'number')
    return {
      heading: 'Title',
      maxHeadingChars: value.maxTitleChars,
      maxBodyChars: null,
      suffix: `; range ≤ ${value.maxRangeDays} days`,
    }
  return null
}

export function AgentApprovalPolicyControl(props: {
  tenantId: string
  venueId: string
  identity: { id: string; identityKey: string; enabled: boolean; accessCapabilities: string[] }
  policies: Policy[]
  outcomeObservations: OutcomeObservation[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [policyKind, setPolicyKind] = useState<'UPDATE' | 'SUPPORT' | 'INTAKE' | 'REPORT'>(() =>
    props.identity.accessCapabilities.includes('updates:draft')
      ? 'UPDATE'
      : props.identity.accessCapabilities.includes('support:draft')
        ? 'SUPPORT'
        : props.identity.accessCapabilities.includes('intake:draft')
          ? 'INTAKE'
          : 'REPORT',
  )
  const [maxTitleChars, setMaxTitleChars] = useState(() =>
    props.identity.accessCapabilities.includes('updates:draft') ? '160' : '200',
  )
  const [maxBodyChars, setMaxBodyChars] = useState(() =>
    props.identity.accessCapabilities.includes('updates:draft') ? '4000' : '20000',
  )
  const [maxUses, setMaxUses] = useState('')
  const [maxRangeDays, setMaxRangeDays] = useState('8')
  const [expiresAt, setExpiresAt] = useState('')
  const [selectedOutcomeIds, setSelectedOutcomeIds] = useState<string[]>([])
  const defaultPolicyKey = useMemo(
    () =>
      `${props.identity.identityKey.replaceAll('.', '-')}-${policyKind === 'UPDATE' ? 'operational-update-drafts' : policyKind === 'SUPPORT' ? 'support-request-drafts' : policyKind === 'INTAKE' ? 'intake-notes-proposals' : 'weekly-report-drafts'}`,
    [props.identity.identityKey, policyKind],
  )
  const canIssueUpdate = props.identity.accessCapabilities.includes('updates:draft')
  const canIssueSupport = props.identity.accessCapabilities.includes('support:draft')
  const canIssueIntake = props.identity.accessCapabilities.includes('intake:draft')
  const canIssueReport = props.identity.accessCapabilities.includes('reports:draft')
  const canIssue =
    props.identity.enabled &&
    (policyKind === 'UPDATE'
      ? canIssueUpdate
      : policyKind === 'SUPPORT'
        ? canIssueSupport
        : policyKind === 'INTAKE'
          ? canIssueIntake
          : canIssueReport)

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const common = {
        operationId: crypto.randomUUID(),
        tenantId: props.tenantId,
        venueId: props.venueId,
        agentIdentityId: props.identity.id,
        policyKey: defaultPolicyKey,
        issueReason: reason,
        outcomeObservationIds: selectedOutcomeIds,
        ...(maxUses ? { maxUses: Number(maxUses) } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
      }
      if (policyKind === 'UPDATE') {
        await client.admin.issueOperationalUpdateDraftPolicy.mutate({
          ...common,
          maxTitleChars: Number(maxTitleChars),
          maxBodyChars: Number(maxBodyChars),
        })
      } else if (policyKind === 'SUPPORT') {
        await client.admin.issueSupportRequestDraftPolicy.mutate({
          ...common,
          maxSubjectChars: Number(maxTitleChars),
          maxBodyChars: Number(maxBodyChars),
        })
      } else if (policyKind === 'INTAKE') {
        await client.admin.issueIntakeNotesProposalPolicy.mutate({
          ...common,
          maxNotesChars: Number(maxBodyChars),
        })
      } else {
        await client.admin.issueWeeklyReportDraftPolicy.mutate({
          ...common,
          maxTitleChars: Number(maxTitleChars),
          maxRangeDays: Number(maxRangeDays),
        })
      }
      setMessage(
        policyKind === 'UPDATE'
          ? 'Update-draft policy enabled. Publication remains unavailable.'
          : policyKind === 'SUPPORT'
            ? 'Support-draft policy enabled. Customer contact remains unavailable.'
            : policyKind === 'INTAKE'
              ? 'Intake-notes policy enabled. Extraction, application, and publication remain unavailable.'
              : 'Weekly-report draft policy enabled. Publication and delivery remain unavailable.',
      )
      setReason('')
      setSelectedOutcomeIds([])
      setExpanded(false)
      router.refresh()
    } catch {
      setMessage('Policy was not enabled. Refresh the evidence and try again.')
    } finally {
      setBusy(false)
    }
  }

  function toggleOutcome(id: string) {
    setSelectedOutcomeIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }

  async function revoke(approvalGrantId: string) {
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.revokeAgentApprovalPolicy.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        approvalGrantId,
        reason: 'Revoked by the founder from the Agent workspace.',
      })
      setMessage('Policy revoked. New actions can no longer consume it.')
      router.refresh()
    } catch {
      setMessage('Policy was not revoked. Refresh the evidence and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h5 className="text-sm font-semibold text-sky-950">Progressive approval policy</h5>
          <p className="mt-1 text-xs leading-5 text-sky-950/75">
            Reviewed policies can let this agent prepare informational update drafts or private
            support drafts, onboarding-notes proposals, or internal weekly-report drafts. They
            cannot apply or publish content, contact a customer, or widen venue access.
          </p>
        </div>
        <button
          type="button"
          disabled={!canIssue || busy || props.outcomeObservations.length === 0}
          onClick={() => setExpanded((value) => !value)}
          className="min-h-10 rounded-xl border border-sky-300 bg-white px-3 text-xs font-semibold text-sky-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {expanded ? 'Close' : 'Add draft policy'}
        </button>
      </div>

      {!canIssue ? (
        <p className="mt-3 text-xs text-amber-900">
          Enable this identity with the selected draft capability before granting policy-backed
          authority.
        </p>
      ) : null}

      {canIssue && props.outcomeObservations.length === 0 ? (
        <p className="mt-3 text-xs text-amber-900">
          No reviewed outcome observations exist for this identity and venue. Record outcomes from
          completed one-shot runs before reducing per-draft approval.
        </p>
      ) : null}

      {props.policies.length ? (
        <ul className="mt-4 space-y-3">
          {props.policies.map((policy) => {
            const limits = policyLimits(policy.constraints)
            return (
              <li key={policy.id} className="rounded-xl border border-sky-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-pf-deep">{policy.policyKey}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-700">
                    {policy.state}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-pf-deep/70">
                  {policy.issueReason || 'No issuance reason was retained for this legacy grant.'}
                </p>
                <p className="mt-2 text-xs text-pf-deep/55">
                  {limits
                    ? `${limits.heading} ≤ ${limits.maxHeadingChars}${limits.maxBodyChars === null ? '' : `; body ≤ ${limits.maxBodyChars}`}${'suffix' in limits ? limits.suffix : ''}`
                    : 'Constraint version unavailable'}{' '}
                  · {policy.useCount} uses
                  {policy.maxUses === null ? '' : ` of ${policy.maxUses}`}
                  {policy.expiresAt ? ` · expires ${policy.expiresAt.toLocaleString()}` : ''}
                </p>
                {policy.authorityEvidence.length ? (
                  <details className="mt-2 text-xs text-pf-deep/65">
                    <summary className="cursor-pointer font-semibold">
                      {policy.authorityEvidence.length} reviewed outcome{' '}
                      {policy.authorityEvidence.length === 1 ? 'observation' : 'observations'}
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {policy.authorityEvidence.map(({ outcomeObservation }) => (
                        <li key={outcomeObservation.id} className="rounded-lg bg-sky-50 p-2">
                          <span className="font-semibold">
                            {outcomeObservation.verdict.replaceAll('_', ' ')} ·{' '}
                            {outcomeObservation.signalKind.replaceAll('_', ' ')}
                          </span>{' '}
                          · {outcomeObservation.taskClass} ·{' '}
                          {outcomeObservation.createdAt.toLocaleString()}
                          <p className="mt-1">{outcomeObservation.summary}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <p className="mt-2 text-xs font-medium text-amber-800">
                    Legacy policy without structured authority evidence.
                  </p>
                )}
                {policy.state === 'ACTIVE' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(policy.id)}
                    className="mt-3 text-xs font-semibold text-rose-700 underline underline-offset-2 disabled:opacity-50"
                  >
                    Revoke policy
                  </button>
                ) : policy.revokeReason ? (
                  <p className="mt-2 text-xs text-pf-deep/55">{policy.revokeReason}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-pf-deep/55">No policy-backed authority is recorded.</p>
      )}

      {expanded && canIssue && props.outcomeObservations.length > 0 ? (
        <form
          onSubmit={issue}
          className="mt-4 grid gap-3 rounded-xl border border-sky-200 bg-white p-4"
        >
          <p className="text-xs font-semibold text-pf-deep">{defaultPolicyKey}</p>
          <fieldset className="grid gap-2 rounded-xl border border-sky-200 p-3">
            <legend className="px-1 text-xs font-semibold text-pf-deep">Draft action class</legend>
            <label className="flex items-start gap-2 text-xs text-pf-deep/75">
              <input
                type="radio"
                name="policy-kind"
                checked={policyKind === 'UPDATE'}
                disabled={!canIssueUpdate}
                onChange={() => {
                  setPolicyKind('UPDATE')
                  setMaxTitleChars('160')
                  setMaxBodyChars('4000')
                }}
              />
              Informational operational-update draft; never publishes.
            </label>
            <label className="flex items-start gap-2 text-xs text-pf-deep/75">
              <input
                type="radio"
                name="policy-kind"
                checked={policyKind === 'SUPPORT'}
                disabled={!canIssueSupport}
                onChange={() => {
                  setPolicyKind('SUPPORT')
                  setMaxTitleChars('200')
                  setMaxBodyChars('20000')
                }}
              />
              Internal support-request draft; never contacts a customer.
            </label>
            <label className="flex items-start gap-2 text-xs text-pf-deep/75">
              <input
                type="radio"
                name="policy-kind"
                checked={policyKind === 'INTAKE'}
                disabled={!canIssueIntake}
                onChange={() => {
                  setPolicyKind('INTAKE')
                  setMaxBodyChars('20000')
                }}
              />
              Onboarding notes proposal; always awaits review and never applies or publishes.
            </label>
            <label className="flex items-start gap-2 text-xs text-pf-deep/75">
              <input
                type="radio"
                name="policy-kind"
                checked={policyKind === 'REPORT'}
                disabled={!canIssueReport}
                onChange={() => {
                  setPolicyKind('REPORT')
                  setMaxTitleChars('200')
                  setMaxRangeDays('8')
                }}
              />
              Internal weekly-report draft generation; may use AI budget, never publishes or
              delivers.
            </label>
          </fieldset>
          <fieldset className="grid gap-2 rounded-xl border border-sky-200 p-3">
            <legend className="px-1 text-xs font-semibold text-pf-deep">
              Outcomes reviewed for this authority decision
            </legend>
            <p className="text-xs leading-5 text-pf-deep/65">
              Select the immutable outcomes you reviewed. They preserve provenance; they do not
              score this worker or recommend approval automatically.
            </p>
            {props.outcomeObservations.map((observation) => (
              <label key={observation.id} className="flex gap-3 rounded-lg bg-sky-50 p-3 text-xs">
                <input
                  type="checkbox"
                  checked={selectedOutcomeIds.includes(observation.id)}
                  onChange={() => toggleOutcome(observation.id)}
                  className="mt-1 size-4"
                />
                <span>
                  <span className="font-semibold text-pf-deep">
                    {observation.verdict.replaceAll('_', ' ')} ·{' '}
                    {observation.signalKind.replaceAll('_', ' ')} · {observation.taskClass}
                  </span>
                  <span className="mt-1 block text-pf-deep/65">{observation.summary}</span>
                  <span className="mt-1 block text-pf-deep/50">
                    {observation.createdAt.toLocaleString()} · run {observation.agentRunId}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="text-xs font-medium text-pf-deep">
            Why this agent may stop requiring per-draft approval for this action class
            <textarea
              required
              minLength={3}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 min-h-20 w-full rounded-xl border border-pf-light px-3 py-2 text-sm"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {policyKind !== 'INTAKE' ? (
              <label className="text-xs font-medium text-pf-deep">
                Maximum {policyKind === 'SUPPORT' ? 'subject' : 'title'} characters
                <input
                  required
                  type="number"
                  min="1"
                  max={policyKind === 'UPDATE' ? '160' : '200'}
                  value={maxTitleChars}
                  onChange={(event) => setMaxTitleChars(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2 text-sm"
                />
              </label>
            ) : null}
            {policyKind === 'REPORT' ? (
              <label className="text-xs font-medium text-pf-deep">
                Maximum report range in days
                <input
                  required
                  type="number"
                  min="1"
                  max="31"
                  value={maxRangeDays}
                  onChange={(event) => setMaxRangeDays(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2 text-sm"
                />
              </label>
            ) : (
              <label className="text-xs font-medium text-pf-deep">
                Maximum {policyKind === 'INTAKE' ? 'notes' : 'body'} characters
                <input
                  required
                  type="number"
                  min="1"
                  max={policyKind === 'UPDATE' ? '4000' : '20000'}
                  value={maxBodyChars}
                  onChange={(event) => setMaxBodyChars(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2 text-sm"
                />
              </label>
            )}
            <label className="text-xs font-medium text-pf-deep">
              Maximum uses (optional)
              <input
                type="number"
                min="1"
                value={maxUses}
                onChange={(event) => setMaxUses(event.target.value)}
                className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-pf-deep">
              Expiration (optional)
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2 text-sm"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={busy || !reason.trim() || selectedOutcomeIds.length === 0}
            className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Saving policy…' : 'Enable bounded draft policy'}
          </button>
        </form>
      ) : null}

      {message ? (
        <p role="status" className="mt-3 text-xs text-pf-deep/70">
          {message}
        </p>
      ) : null}
    </section>
  )
}
