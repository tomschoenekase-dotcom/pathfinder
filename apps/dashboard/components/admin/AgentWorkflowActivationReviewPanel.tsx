'use client'

import React, { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { AgentWorkflowCanaryPolicySchema } from '@pathfinder/contracts/agent-workflow-activation'
import { ApprovalDecisionForm } from './ApprovalDecisionForm'
import { useTRPCClient } from '../../lib/trpc'

export type AgentWorkflowActivationReviewPage = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['getAgentWorkflowActivationReview']['query']>
>
type ApprovalReceipt = NonNullable<
  AgentWorkflowActivationReviewPage['approvalRequests'][number]['receipt']
>

function ApprovalTerms({
  receipt,
  expiresAt,
}: {
  receipt: ApprovalReceipt
  expiresAt: string | Date | null
}) {
  const policy = receipt.canaryPolicy
  return (
    <details className="mt-3 rounded-xl border border-pf-light bg-white/65 p-3 text-sm">
      <summary className="cursor-pointer font-semibold text-pf-deep">Review approval terms</summary>
      <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-2 [overflow-wrap:anywhere]">
        <div>
          <dt className="text-pf-deep/65">Expected head revision</dt>
          <dd className="font-semibold">{receipt.expectedHeadRevision}</dd>
        </div>
        {'kind' in receipt ? (
          <div>
            <dt className="text-pf-deep/65">Transition</dt>
            <dd className="font-semibold">{receipt.kind}</dd>
          </div>
        ) : (
          <>
            <div>
              <dt className="text-pf-deep/65">Candidate version ID</dt>
              <dd className="font-mono text-xs">{receipt.workflowVersionId}</dd>
            </div>
            <div>
              <dt className="text-pf-deep/65">Assessment ID</dt>
              <dd className="font-mono text-xs">{receipt.promotionAssessmentId}</dd>
            </div>
          </>
        )}
        {'kind' in receipt && receipt.workflowVersionId ? (
          <div>
            <dt className="text-pf-deep/65">Rollback target version ID</dt>
            <dd className="font-mono text-xs">{receipt.workflowVersionId}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-pf-deep/65">Decision expiry (UTC)</dt>
          <dd>{expiresAt ? new Date(expiresAt).toISOString() : 'No expiry recorded'}</dd>
        </div>
        {policy ? (
          <>
            <div>
              <dt className="text-pf-deep/65">Selection</dt>
              <dd>
                {policy.numerator} / {policy.denominator} · maximum {policy.maxSelectedRuns} runs
              </dd>
            </div>
            <div>
              <dt className="text-pf-deep/65">Window (UTC)</dt>
              <dd>
                {policy.startsAt} – {policy.endsAt}
              </dd>
            </div>
            <div>
              <dt className="text-pf-deep/65">Eligible run types</dt>
              <dd>{policy.eligibleRunTypes.join(', ')}</dd>
            </div>
            <div>
              <dt className="text-pf-deep/65">Eligible operations</dt>
              <dd>{policy.eligibleOperations.join(', ')}</dd>
            </div>
            <div>
              <dt className="text-pf-deep/65">Supported effects</dt>
              <dd>{policy.supportedActionClasses.join(', ')}</dd>
            </div>
            <div>
              <dt className="text-pf-deep/65">Skipped-run baseline</dt>
              <dd>
                {policy.skippedBaseline.kind === 'NO_WORKFLOW'
                  ? 'No workflow'
                  : `Prior version ${policy.skippedBaseline.workflowVersionId} (${policy.skippedBaseline.contentHash})`}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-pf-deep/65">Selection salt</dt>
              <dd className="font-mono text-xs">{policy.salt}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt className="text-pf-deep/65">Canary policy</dt>
            <dd>
              {'kind' in receipt && receipt.kind === 'REVOKE' ? 'Not applicable' : 'Unavailable'}
            </dd>
          </div>
        )}
      </dl>
    </details>
  )
}

export function AgentWorkflowActivationReviewPanel({
  tenantId,
  venueId,
  initialPage,
}: {
  tenantId: string
  venueId: string
  initialPage: AgentWorkflowActivationReviewPage
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const scope = JSON.stringify([tenantId, venueId])
  const scopeRef = useRef(scope)
  const initialPageRef = useRef(initialPage)
  initialPageRef.current = initialPage
  const generation = useRef(0)
  const identitySequence = useRef(0)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const frozenRequest = useRef<Record<string, unknown> | null>(null)
  const frozenApply = useRef<{
    requestId: string
    action: string
    payload: Record<string, unknown>
  } | null>(null)
  const [page, setPage] = useState(initialPage)
  const [readyScope, setReadyScope] = useState(scope)
  const [candidateId, setCandidateId] = useState('')
  const [identityId, setIdentityId] = useState('')
  const [runType, setRunType] = useState('')
  const [operationConfirmed, setOperationConfirmed] = useState(false)
  const [numerator, setNumerator] = useState('')
  const [denominator, setDenominator] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [maxRuns, setMaxRuns] = useState('')
  const [salt, setSalt] = useState('')
  const [baseline, setBaseline] = useState<'NO_WORKFLOW' | 'PRIOR_VERSION' | ''>('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    scopeRef.current = scope
    generation.current += 1
    busyRef.current = false
    frozenRequest.current = null
    frozenApply.current = null
    setPage(initialPageRef.current)
    setCandidateId('')
    setIdentityId('')
    setRunType('')
    setOperationConfirmed(false)
    setNumerator('')
    setDenominator('')
    setStartsAt('')
    setEndsAt('')
    setMaxRuns('')
    setSalt('')
    setBaseline('')
    setReason('')
    setBusy(false)
    setFeedback(null)
    setReadyScope(scope)
  }, [scope])
  useEffect(() => {
    if (!busyRef.current) setPage(initialPage)
  }, [initialPage])
  useEffect(
    () => () => {
      mounted.current = false
      generation.current += 1
      identitySequence.current += 1
    },
    [],
  )

  const candidate = page.candidates.find((item) => item.version.id === candidateId)
  const head = candidate
    ? page.heads.find((item) => item.registryKey === candidate.version.registryKey)
    : null
  function canaryPolicy() {
    if (![numerator, denominator, maxRuns].every((value) => value.trim().length > 0)) return null
    const startValue = Date.parse(startsAt)
    const endValue = Date.parse(endsAt)
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null
    const prior = head?.activeVersion
    if (baseline === 'PRIOR_VERSION' && !prior) return null
    const parsed = AgentWorkflowCanaryPolicySchema.safeParse({
      numerator: Number(numerator),
      denominator: Number(denominator),
      maxSelectedRuns: Number(maxRuns),
      salt: salt.trim(),
      startsAt: new Date(startValue).toISOString(),
      endsAt: new Date(endValue).toISOString(),
      eligibleRunTypes: runType ? [runType] : [],
      eligibleOperations: operationConfirmed ? ['operator_task'] : [],
      supportedActionClasses: ['RUN_TERMINAL_WRITE'],
      skippedBaseline:
        baseline === 'PRIOR_VERSION' && prior
          ? { kind: 'PRIOR_VERSION', workflowVersionId: prior.id, contentHash: prior.contentHash }
          : { kind: 'NO_WORKFLOW' },
    })
    return parsed.success ? parsed.data : null
  }
  const validPolicy = canaryPolicy()
  const formValid = Boolean(
    candidate?.assessment?.diagnosticsShapeValid &&
    identityId &&
    baseline &&
    reason.trim().length > 0 &&
    reason.trim().length <= 2000 &&
    validPolicy,
  )
  const mutationLocked = busy || Boolean(frozenRequest.current) || Boolean(frozenApply.current)

  async function chooseIdentity(id: string) {
    const selection = ++identitySequence.current
    identityIdRef.current = id
    setIdentityId(id)
    setRunType('')
    if (!id) return
    const started = generation.current
    try {
      const identity = await client.admin.getAgentIdentity.query({
        tenantId,
        venueId,
        agentIdentityId: id,
      })
      if (
        mounted.current &&
        selection === identitySequence.current &&
        id === identityIdRef.current &&
        started === generation.current &&
        scopeRef.current === scope
      )
        setRunType(identity.agentType)
    } catch {
      if (
        mounted.current &&
        selection === identitySequence.current &&
        started === generation.current &&
        scopeRef.current === scope
      )
        setFeedback('Agent type could not be loaded.')
    }
  }

  const identityIdRef = useRef(identityId)
  identityIdRef.current = identityId

  function requestPayload() {
    if (
      busyRef.current ||
      frozenRequest.current ||
      frozenApply.current ||
      !candidate ||
      !candidate.assessment?.diagnosticsShapeValid ||
      !identityId ||
      !baseline ||
      !reason.trim() ||
      reason.trim().length > 2000 ||
      !validPolicy
    )
      return null
    return structuredClone({
      operationId: crypto.randomUUID(),
      tenantId,
      venueId,
      agentIdentityId: identityId,
      registryKey: candidate.version.registryKey,
      workflowVersionId: candidate.version.id,
      promotionAssessmentId: candidate.assessment.id,
      expectedHeadRevision: head?.revision ?? 0,
      reason: reason.trim(),
      canaryPolicy: validPolicy,
    })
  }

  function errorCode(error: unknown) {
    if (!error || typeof error !== 'object' || !('data' in error)) return null
    const data = error.data
    return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
      ? data.code
      : null
  }

  const definitiveCodes = new Set([
    'BAD_REQUEST',
    'CONFLICT',
    'FORBIDDEN',
    'NOT_FOUND',
    'PRECONDITION_FAILED',
    'UNAUTHORIZED',
  ])

  async function sendRequest(payload: Record<string, unknown>) {
    if (busyRef.current) return
    const started = generation.current
    busyRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await client.admin.requestAgentWorkflowActivationApproval.mutate(payload as never)
      if (started !== generation.current || scopeRef.current !== scope) return
      frozenRequest.current = null
      setFeedback('Approval request recorded. Refreshing review evidence.')
      router.refresh()
    } catch (error) {
      if (started !== generation.current || scopeRef.current !== scope) return
      if (definitiveCodes.has(errorCode(error) ?? '')) {
        frozenRequest.current = null
        setFeedback('The approval request was rejected. Review the current evidence and fields.')
      } else
        setFeedback('The request outcome is uncertain. Retry the exact frozen request or refresh.')
    } finally {
      if (started === generation.current && scopeRef.current === scope) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const payload = requestPayload()
    if (!payload) return
    frozenRequest.current = payload
    void sendRequest(payload)
  }

  async function applyReviewed(
    requestId: string,
    action: string,
    payload: Record<string, unknown>,
  ) {
    if (busyRef.current) return
    if (frozenApply.current && frozenApply.current.requestId !== requestId) {
      setFeedback('Resolve the uncertain Apply before starting another transition.')
      return
    }
    const frozen = frozenApply.current ?? { requestId, action, payload: structuredClone(payload) }
    frozenApply.current = frozen
    const started = generation.current
    busyRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      if (frozen.action === 'agent-workflow.activate')
        await client.admin.applyAgentWorkflowActivation.mutate(frozen.payload as never)
      else await client.admin.applyAgentWorkflowTransition.mutate(frozen.payload as never)
      if (started !== generation.current || scopeRef.current !== scope) return
      frozenApply.current = null
      setFeedback('Workflow transition recorded. Refreshing immutable history.')
      router.refresh()
    } catch (error) {
      if (started !== generation.current || scopeRef.current !== scope) return
      if (definitiveCodes.has(errorCode(error) ?? '')) {
        frozenApply.current = null
        setFeedback(
          'Apply was rejected. Refresh the authoritative workflow review before retrying.',
        )
      } else
        setFeedback(
          'The Apply outcome is uncertain. Retry the exact frozen Apply request or refresh.',
        )
    } finally {
      if (started === generation.current && scopeRef.current === scope) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  async function loadMore(kind: 'candidates' | 'requests') {
    if (busyRef.current) return
    const cursor = kind === 'candidates' ? page.nextCandidateBefore : page.nextRequestBefore
    if (!cursor) return
    const started = generation.current
    busyRef.current = true
    setBusy(true)
    try {
      const result = await client.admin.getAgentWorkflowActivationReview.query({
        tenantId,
        venueId,
        limit: 20,
        ...(kind === 'candidates' ? { candidateBefore: cursor } : { requestBefore: cursor }),
      })
      if (started !== generation.current || scopeRef.current !== scope) return
      setPage((current) =>
        kind === 'candidates'
          ? {
              ...current,
              candidates: [
                ...current.candidates,
                ...result.candidates.filter(
                  (next) => !current.candidates.some((item) => item.version.id === next.version.id),
                ),
              ],
              nextCandidateBefore: result.nextCandidateBefore,
              heads: [
                ...current.heads,
                ...result.heads.filter(
                  (next) => !current.heads.some((item) => item.registryKey === next.registryKey),
                ),
              ],
            }
          : {
              ...current,
              approvalRequests: [
                ...current.approvalRequests,
                ...result.approvalRequests.filter(
                  (next) => !current.approvalRequests.some((item) => item.id === next.id),
                ),
              ],
              nextRequestBefore: result.nextRequestBefore,
            },
      )
    } catch {
      if (started === generation.current) setFeedback(`More ${kind} could not be loaded.`)
    } finally {
      if (started === generation.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  if (readyScope !== scope)
    return (
      <p role="status" className="text-sm text-pf-deep/65">
        Loading workflow review for this venue…
      </p>
    )
  return (
    <section
      id="workflow-review"
      className="space-y-5 border-t border-pf-light pt-7"
      aria-labelledby="workflow-review-heading"
    >
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Reviewed rollout
        </p>
        <h3 id="workflow-review-heading" className="mt-1 text-xl font-semibold text-pf-deep">
          Review a workflow canary
        </h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-pf-deep/65">
          Evidence stays review-only until a human decision and a separate Apply. Workflow text is
          checked again during Apply; this list does not load the body.
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-4 border-y border-pf-light py-5 lg:grid-cols-2">
        <label className="text-sm font-semibold text-pf-deep">
          Candidate version
          <select
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3"
            value={candidateId}
            onChange={(event) => {
              setCandidateId(event.target.value)
              setBaseline('')
            }}
            disabled={mutationLocked}
          >
            <option value="">Choose a reviewed candidate</option>
            {page.candidates.map(({ version }) => (
              <option key={version.id} value={version.id}>
                {version.registryKey} · version {version.version}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold text-pf-deep">
          Bookkeeping identity
          <select
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3"
            value={identityId}
            onChange={(event) => void chooseIdentity(event.target.value)}
            disabled={mutationLocked}
          >
            <option value="">Choose an enabled identity</option>
            {page.enabledIdentities.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.name} · {identity.identityKey}
              </option>
            ))}
          </select>
        </label>
        {candidate ? (
          <div className="lg:col-span-2 border-l-4 border-amber-300 pl-4 text-sm text-pf-deep/75">
            <strong>
              {candidate.compatibility.status === 'CURRENTLY_AVAILABLE'
                ? 'Tools currently available.'
                : `Missing tools: ${candidate.compatibility.missingCapabilities.join(', ')}`}
            </strong>{' '}
            Body integrity is not checked in this read view. Apply revalidates the artifact and
            evaluation receipts.
            {candidate.assessment?.diagnostics ? (
              <span className="block mt-1">
                Development: {candidate.assessment.diagnostics.development.caseCount} cases,{' '}
                {candidate.assessment.diagnostics.development.resolvedFailures} resolved,{' '}
                {candidate.assessment.diagnostics.development.newFailures} new,{' '}
                {candidate.assessment.diagnostics.development.missingResults} missing. Heldout:{' '}
                {candidate.assessment.diagnostics.heldout.caseCount} cases,{' '}
                {candidate.assessment.diagnostics.heldout.resolvedFailures} resolved,{' '}
                {candidate.assessment.diagnostics.heldout.newFailures} new,{' '}
                {candidate.assessment.diagnostics.heldout.missingResults} missing. Recorded latency
                delta: {candidate.assessment.diagnostics.heldout.latencyDeltaMs ?? 'not recorded'};
                recorded cost delta:{' '}
                {candidate.assessment.diagnostics.heldout.costDeltaE8Usd ?? 'not recorded'}.
                Limitations: {candidate.assessment.diagnostics.limitations.join(' ')}
              </span>
            ) : (
              <span className="block mt-1">Parsed assessment evidence is unavailable.</span>
            )}
          </div>
        ) : null}
        <label className="text-sm">
          Selected / denominator
          <input
            aria-label="Selected numerator"
            className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2"
            inputMode="numeric"
            value={numerator}
            onChange={(e) => setNumerator(e.target.value)}
            disabled={mutationLocked}
          />
          <input
            aria-label="Selection denominator"
            className="mt-2 w-full rounded-xl border border-pf-light px-3 py-2"
            inputMode="numeric"
            value={denominator}
            onChange={(e) => setDenominator(e.target.value)}
            disabled={mutationLocked}
          />
        </label>
        <label className="text-sm">
          Maximum selected runs
          <input
            className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2"
            inputMode="numeric"
            value={maxRuns}
            onChange={(e) => setMaxRuns(e.target.value)}
            disabled={mutationLocked}
          />
        </label>
        <label className="text-sm">
          Starts at (your local time; stored as UTC)
          <input
            type="datetime-local"
            aria-label="Starts at"
            className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            disabled={mutationLocked}
          />
        </label>
        <label className="text-sm">
          Ends at (your local time; stored as UTC)
          <input
            type="datetime-local"
            aria-label="Ends at"
            className="mt-1 w-full rounded-xl border border-pf-light px-3 py-2"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            disabled={mutationLocked}
          />
        </label>
        <label className="text-sm lg:col-span-2">
          Visible selection salt
          <div className="mt-1 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-xl border border-pf-light px-3 py-2"
              value={salt}
              onChange={(e) => setSalt(e.target.value)}
              disabled={mutationLocked}
            />
            <button
              type="button"
              className="rounded-xl border border-pf-primary px-3 text-sm font-semibold"
              onClick={() => setSalt(crypto.randomUUID())}
              disabled={mutationLocked}
            >
              Generate salt
            </button>
          </div>
        </label>
        <fieldset className="text-sm">
          <legend className="font-semibold">Skipped-run baseline</legend>
          <label className="mt-2 block">
            <input
              type="radio"
              checked={baseline === 'NO_WORKFLOW'}
              onChange={() => setBaseline('NO_WORKFLOW')}
              disabled={mutationLocked}
            />{' '}
            No workflow
          </label>
          {head?.activeVersion ? (
            <label className="mt-2 block">
              <input
                type="radio"
                checked={baseline === 'PRIOR_VERSION'}
                onChange={() => setBaseline('PRIOR_VERSION')}
                disabled={mutationLocked}
              />{' '}
              Current version {head.activeVersion.version}
            </label>
          ) : null}
        </fieldset>
        <div className="text-sm">
          <p>
            <strong>Eligible run type:</strong> {runType || 'Choose an identity'}
          </p>
          <p>
            <label className="block">
              <input
                type="checkbox"
                checked={operationConfirmed}
                onChange={(event) => setOperationConfirmed(event.target.checked)}
                disabled={mutationLocked}
              />{' '}
              Use canonical operator_task
            </label>
          </p>
          <p>
            <strong>Effect:</strong> terminal run write only
          </p>
        </div>
        <label className="text-sm lg:col-span-2">
          Review reason
          <textarea
            className="mt-1 min-h-24 w-full rounded-xl border border-pf-light px-3 py-2"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={mutationLocked}
          />
        </label>
        <div className="flex flex-wrap gap-2 lg:col-span-2">
          <button
            className="rounded-xl bg-pf-primary px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            disabled={mutationLocked || !formValid}
          >
            Request human approval
          </button>
          {frozenRequest.current ? (
            <button
              type="button"
              className="rounded-xl border border-pf-primary px-4 py-2.5 text-sm font-semibold"
              disabled={busy}
              onClick={() => void sendRequest(frozenRequest.current!)}
            >
              Retry exact request
            </button>
          ) : null}
        </div>
      </form>
      {page.nextCandidateBefore ? (
        <button
          type="button"
          className="rounded-xl border border-pf-light px-3 py-2 text-sm font-semibold"
          disabled={mutationLocked}
          onClick={() => void loadMore('candidates')}
        >
          Load more candidates
        </button>
      ) : null}
      {feedback ? (
        <p role="status" className="text-sm font-semibold text-pf-deep">
          {feedback}
        </p>
      ) : null}
      <div className="space-y-3">
        <h4 className="font-semibold text-pf-deep">Approval history</h4>
        {page.approvalRequests.length === 0 ? (
          <p className="text-sm text-pf-deep/70">No workflow approval requests recorded.</p>
        ) : (
          page.approvalRequests.map((request) => (
            <article
              key={request.id}
              className="min-w-0 border-t border-pf-light pt-3 [overflow-wrap:anywhere]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-pf-deep">
                  {request.proposedAction.replace('agent-workflow.', '').toUpperCase()} ·{' '}
                  {request.receipt?.registryKey ?? 'Invalid receipt'}
                </p>
                <span className="text-xs font-semibold">
                  {request.appliedEventCorrelation === 'APPLIED'
                    ? `Applied · revision ${request.appliedEvent?.resultingRevision}`
                    : request.appliedEventCorrelation === 'AMBIGUOUS'
                      ? 'Event correlation needs investigation'
                      : (request.decision?.decision ?? 'Awaiting decision')}
                </span>
              </div>
              <p className="mt-1 text-sm text-pf-deep/65">{request.reason}</p>
              {request.receipt ? (
                <ApprovalTerms receipt={request.receipt} expiresAt={request.expiresAt} />
              ) : (
                <p className="mt-2 text-sm font-semibold text-red-700">
                  Approval terms are unavailable because the stored receipt is invalid.
                </p>
              )}
              {!request.decision && request.receiptShapeValid ? (
                <div className="mt-3 max-w-xl">
                  <ApprovalDecisionForm
                    tenantId={tenantId}
                    venueId={venueId}
                    approvalRequestId={request.id}
                    proposedAction={request.proposedAction}
                  />
                </div>
              ) : null}
              {request.reviewedApplyInput && request.appliedEventCorrelation === 'NONE' ? (
                <button
                  type="button"
                  disabled={mutationLocked}
                  className="mt-3 rounded-xl bg-pf-primary px-4 py-2 text-sm font-semibold text-white"
                  onClick={() =>
                    void applyReviewed(request.id, request.proposedAction, {
                      operationId: crypto.randomUUID(),
                      tenantId,
                      venueId,
                      ...request.reviewedApplyInput!.receipt,
                      approvalDecisionId: request.reviewedApplyInput!.approvalDecisionId,
                      reason: request.reason,
                    })
                  }
                >
                  Apply reviewed {request.proposedAction.split('.').at(-1)}
                </button>
              ) : null}
              {frozenApply.current?.requestId === request.id ? (
                <button
                  type="button"
                  disabled={busy}
                  className="ml-2 mt-3 rounded-xl border border-pf-primary px-4 py-2 text-sm font-semibold"
                  onClick={() =>
                    void applyReviewed(
                      request.id,
                      frozenApply.current!.action,
                      frozenApply.current!.payload,
                    )
                  }
                >
                  Retry exact Apply
                </button>
              ) : null}
            </article>
          ))
        )}
      </div>
      {page.nextRequestBefore ? (
        <button
          type="button"
          className="rounded-xl border border-pf-light px-3 py-2 text-sm font-semibold"
          disabled={mutationLocked}
          onClick={() => void loadMore('requests')}
        >
          Load more approval history
        </button>
      ) : null}
    </section>
  )
}
