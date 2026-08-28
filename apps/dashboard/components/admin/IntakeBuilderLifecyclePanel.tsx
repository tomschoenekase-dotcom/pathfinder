'use client'

import { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

export type IntakeBuilderLifecycle =
  inferRouterOutputs<AppRouter>['admin']['getIntakeBuilderLifecycle']
type Lifecycle = IntakeBuilderLifecycle
type Stage = Lifecycle['stages'][number]
type WebsiteMappingPreview =
  inferRouterOutputs<AppRouter>['admin']['previewWebsiteVenuePackageMapping']

const stateStyles: Record<Stage['state'], string> = {
  COMPLETE: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  CURRENT: 'border-sky-200 bg-sky-50 text-sky-950',
  BLOCKED: 'border-amber-300 bg-amber-50 text-amber-950',
  PENDING: 'border-slate-200 bg-slate-50 text-slate-700',
  SKIPPED: 'border-slate-200 bg-white text-slate-700',
}

function stageLabel(stage: Stage['stage']) {
  return stage.charAt(0) + stage.slice(1).toLowerCase()
}

export function IntakeBuilderLifecyclePanel({
  tenantId,
  venueId,
  runId,
}: {
  tenantId: string
  venueId: string
  runId: string
}) {
  const client = useTRPCClient()
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [researchBusy, setResearchBusy] = useState(false)
  const [researchError, setResearchError] = useState<string | null>(null)
  const [clarificationBusy, setClarificationBusy] = useState(false)
  const [clarificationError, setClarificationError] = useState<string | null>(null)
  const [clarificationIdentityId, setClarificationIdentityId] = useState('')
  const [mappingSelections, setMappingSelections] = useState<Record<string, string>>({})
  const [mappingPreview, setMappingPreview] = useState<WebsiteMappingPreview | null>(null)
  const [mappingReviewed, setMappingReviewed] = useState(false)
  const [mappingBusy, setMappingBusy] = useState(false)
  const [mappingError, setMappingError] = useState<string | null>(null)
  const sequence = useRef(0)
  const researchOperationId = useRef<string | null>(null)

  useEffect(() => {
    sequence.current += 1
    setLifecycle(null)
    setError(null)
    setBusy(false)
    setResearchBusy(false)
    setResearchError(null)
    setClarificationBusy(false)
    setClarificationError(null)
    setClarificationIdentityId('')
    setMappingSelections({})
    setMappingPreview(null)
    setMappingReviewed(false)
    setMappingBusy(false)
    setMappingError(null)
    researchOperationId.current = null
  }, [runId, tenantId, venueId])

  async function load() {
    const request = ++sequence.current
    setBusy(true)
    setError(null)
    try {
      const result = await client.admin.getIntakeBuilderLifecycle.query({
        tenantId,
        venueId,
        runId,
      })
      if (request === sequence.current) {
        setLifecycle(result)
        setClarificationIdentityId(
          (current) =>
            current ||
            result.websiteClarificationReview?.eligibleIdentities[0]?.id ||
            result.interviewClarificationReview?.eligibleIdentities[0]?.id ||
            '',
        )
      }
    } catch (cause) {
      if (request === sequence.current) {
        setError(cause instanceof Error ? cause.message : 'Builder lifecycle is unavailable.')
      }
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }

  async function createClarificationQuestions() {
    const websiteReview = lifecycle?.websiteClarificationReview
    const interviewReview = lifecycle?.interviewClarificationReview
    if ((!websiteReview && !interviewReview) || !clarificationIdentityId || clarificationBusy)
      return
    setClarificationBusy(true)
    setClarificationError(null)
    try {
      if (websiteReview) {
        const discrepancyIds = websiteReview.clarifications
          .filter(({ question }) => question === null)
          .map(({ discrepancyId }) => discrepancyId)
        if (discrepancyIds.length === 0) return
        await client.admin.createWebsiteResearchClarificationQuestions.mutate({
          tenantId,
          venueId,
          runId,
          receiptId: websiteReview.receiptId,
          expectedResearchHash: websiteReview.researchHash,
          discrepancyIds,
          agentIdentityId: clarificationIdentityId,
        })
      } else if (interviewReview) {
        const clarificationIds = interviewReview.clarifications
          .filter(({ question }) => question === null)
          .map(({ clarificationId }) => clarificationId)
        if (clarificationIds.length === 0) return
        await client.admin.createInterviewClarificationQuestions.mutate({
          tenantId,
          venueId,
          runId,
          expectedReviewHash: interviewReview.reviewHash,
          clarificationIds,
          agentIdentityId: clarificationIdentityId,
        })
      }
      await load()
    } catch (cause) {
      setClarificationError(
        cause instanceof Error ? cause.message : 'Clarification questions could not be retained.',
      )
    } finally {
      setClarificationBusy(false)
    }
  }

  function mappingSelectionList() {
    return Object.entries(mappingSelections)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([fieldPath, evidenceId]) => ({ fieldPath, evidenceId }))
  }

  async function previewWebsiteMapping() {
    const review = lifecycle?.websiteClarificationReview
    const selections = mappingSelectionList()
    if (!review || selections.length === 0 || mappingBusy) return
    setMappingBusy(true)
    setMappingError(null)
    setMappingPreview(null)
    setMappingReviewed(false)
    try {
      setMappingPreview(
        await client.admin.previewWebsiteVenuePackageMapping.query({
          tenantId,
          venueId,
          runId,
          receiptId: review.receiptId,
          expectedResearchHash: review.researchHash,
          selections,
        }),
      )
    } catch (cause) {
      setMappingError(cause instanceof Error ? cause.message : 'Website mapping preview failed.')
    } finally {
      setMappingBusy(false)
    }
  }

  async function createWebsiteMappingDraft() {
    const review = lifecycle?.websiteClarificationReview
    if (!review || !mappingPreview || !mappingReviewed || mappingBusy) return
    setMappingBusy(true)
    setMappingError(null)
    try {
      await client.admin.createAndLinkWebsiteMappingDraft.mutate({
        tenantId,
        venueId,
        runId,
        receiptId: review.receiptId,
        expectedResearchHash: review.researchHash,
        expectedMappingReviewHash: mappingPreview.mappingReviewHash,
        expectedCandidateHash: mappingPreview.candidateHash,
        selections: mappingSelectionList(),
      })
      await load()
    } catch (cause) {
      setMappingError(cause instanceof Error ? cause.message : 'Website mapping DRAFT failed.')
    } finally {
      setMappingBusy(false)
    }
  }

  async function runWebsiteResearch() {
    if (!lifecycle || researchBusy) return
    const operationId = researchOperationId.current ?? crypto.randomUUID()
    researchOperationId.current = operationId
    setResearchBusy(true)
    setResearchError(null)
    try {
      await client.admin.executeWebsiteIntakeResearch.mutate({
        tenantId,
        venueId,
        runId,
        operationId,
        ...(lifecycle.websiteResearch?.receiptId
          ? { priorReceiptId: lifecycle.websiteResearch.receiptId }
          : {}),
      })
      researchOperationId.current = null
      await load()
    } catch (cause) {
      setResearchError(
        cause instanceof Error ? cause.message : 'Website research could not be retained.',
      )
    } finally {
      setResearchBusy(false)
    }
  }

  if (!lifecycle) {
    return (
      <div className="mt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="min-h-11 rounded-full border border-pf-light px-4 text-sm font-medium text-pf-deep disabled:opacity-50"
        >
          {busy ? 'Checking Builder…' : error ? 'Retry Builder status' : 'Inspect Builder status'}
        </button>
        {error ? (
          <p className="mt-2 text-sm text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <IntakeBuilderLifecycleView
      lifecycle={lifecycle}
      onRunWebsiteResearch={() => void runWebsiteResearch()}
      researchBusy={researchBusy}
      researchError={researchError}
      clarificationBusy={clarificationBusy}
      clarificationError={clarificationError}
      clarificationIdentityId={clarificationIdentityId}
      onClarificationIdentityChange={setClarificationIdentityId}
      onCreateClarificationQuestions={() => void createClarificationQuestions()}
      mappingSelections={mappingSelections}
      mappingPreview={mappingPreview}
      mappingReviewed={mappingReviewed}
      mappingBusy={mappingBusy}
      mappingError={mappingError}
      onMappingSelectionChange={(fieldPath, evidenceId) => {
        setMappingSelections((current) => ({ ...current, [fieldPath]: evidenceId }))
        setMappingPreview(null)
        setMappingReviewed(false)
        setMappingError(null)
      }}
      onPreviewWebsiteMapping={() => void previewWebsiteMapping()}
      onMappingReviewedChange={setMappingReviewed}
      onCreateWebsiteMappingDraft={() => void createWebsiteMappingDraft()}
    />
  )
}

export function IntakeBuilderLifecycleView({
  lifecycle,
  onRunWebsiteResearch,
  researchBusy = false,
  researchError = null,
  clarificationBusy = false,
  clarificationError = null,
  clarificationIdentityId = '',
  onClarificationIdentityChange,
  onCreateClarificationQuestions,
  mappingSelections = {},
  mappingPreview = null,
  mappingReviewed = false,
  mappingBusy = false,
  mappingError = null,
  onMappingSelectionChange,
  onPreviewWebsiteMapping,
  onMappingReviewedChange,
  onCreateWebsiteMappingDraft,
}: {
  lifecycle: Lifecycle
  onRunWebsiteResearch?: () => void
  researchBusy?: boolean
  researchError?: string | null
  clarificationBusy?: boolean
  clarificationError?: string | null
  clarificationIdentityId?: string
  onClarificationIdentityChange?: (identityId: string) => void
  onCreateClarificationQuestions?: () => void
  mappingSelections?: Record<string, string>
  mappingPreview?: WebsiteMappingPreview | null
  mappingReviewed?: boolean
  mappingBusy?: boolean
  mappingError?: string | null
  onMappingSelectionChange?: (fieldPath: string, evidenceId: string) => void
  onPreviewWebsiteMapping?: () => void
  onMappingReviewedChange?: (reviewed: boolean) => void
  onCreateWebsiteMappingDraft?: () => void
}) {
  const active = lifecycle.stages.find(({ stage }) => stage === lifecycle.currentStage)!
  const mappingGroups = Object.entries(
    (lifecycle.websiteClarificationReview?.mappingOptions ?? []).reduce<
      Record<string, NonNullable<Lifecycle['websiteClarificationReview']>['mappingOptions']>
    >((groups, option) => {
      const fieldOptions = (groups[option.fieldPath] ??= [])
      fieldOptions.push(option)
      return groups
    }, {}),
  )
  const mappingComplete =
    lifecycle.stages.find(({ stage }) => stage === 'CONSTRUCT')?.state === 'COMPLETE'
  const clarificationReview =
    lifecycle.websiteClarificationReview ?? lifecycle.interviewClarificationReview
  const interviewClarifications = lifecycle.interviewClarificationReview !== null
  return (
    <section
      className="mt-4 rounded-xl border border-pf-light bg-slate-50 p-4"
      aria-label="Builder lifecycle"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
            Builder VNext
          </p>
          <h3 className="mt-1 font-semibold text-pf-deep">
            {stageLabel(lifecycle.currentStage)} · {lifecycle.currentState.toLowerCase()}
          </h3>
          <p className="mt-1 text-sm text-pf-deep/70">
            Next: {lifecycle.nextAction.replaceAll('_', ' ').toLowerCase()}
          </p>
        </div>
        <span className="rounded-full border border-pf-light bg-white px-3 py-1 text-xs font-medium text-pf-deep/70">
          {lifecycle.stages.filter(({ state }) => state === 'COMPLETE').length}/14 complete
        </span>
      </div>

      <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {lifecycle.stages.map((stage) => (
          <li
            key={stage.stage}
            className={`rounded-lg border px-2 py-2 text-xs ${stateStyles[stage.state]}`}
            aria-current={stage.stage === lifecycle.currentStage ? 'step' : undefined}
          >
            <span className="block font-semibold">{stageLabel(stage.stage)}</span>
            <span className="mt-0.5 block">{stage.state.toLowerCase()}</span>
          </li>
        ))}
      </ol>

      {active.blockers.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-white p-3" role="status">
          <p className="text-sm font-semibold text-amber-950">Current blockers</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {active.blockers.map((item) => (
              <li key={`${item.code}:${item.path}`}>{item.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {lifecycle.websiteResearch ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-pf-deep/60">Attempt</dt>
            <dd className="font-semibold text-pf-deep">
              {lifecycle.websiteResearch.attemptCount}/4
            </dd>
          </div>
          <div>
            <dt className="text-xs text-pf-deep/60">Pages</dt>
            <dd className="font-semibold text-pf-deep">{lifecycle.websiteResearch.fetchedPages}</dd>
          </div>
          <div>
            <dt className="text-xs text-pf-deep/60">Downloaded</dt>
            <dd className="font-semibold text-pf-deep">
              {Math.ceil(lifecycle.websiteResearch.fetchedBytes / 1024).toLocaleString()} KB
            </dd>
          </div>
          <div>
            <dt className="text-xs text-pf-deep/60">Cost · time</dt>
            <dd className="font-semibold text-pf-deep">
              {lifecycle.websiteResearch.estimatedCostUnits} units ·{' '}
              {(lifecycle.websiteResearch.latencyMs / 1000).toFixed(1)}s
            </dd>
          </div>
        </dl>
      ) : null}

      {onRunWebsiteResearch &&
      (lifecycle.nextAction === 'RUN_WEBSITE_RESEARCH' ||
        lifecycle.nextAction === 'RETRY_WEBSITE_RESEARCH') ? (
        <div className="mt-4">
          <button
            type="button"
            disabled={researchBusy}
            onClick={onRunWebsiteResearch}
            className="min-h-11 rounded-full bg-pf-primary px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-pf-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
          >
            {researchBusy
              ? 'Researching website…'
              : lifecycle.nextAction === 'RETRY_WEBSITE_RESEARCH'
                ? 'Retry bounded research'
                : 'Run bounded research'}
          </button>
          <p className="mt-2 text-xs text-pf-deep/60">
            Up to 5 pages, one link level, 20 cost units, and 30 seconds. Results stay review-only.
          </p>
        </div>
      ) : null}
      {researchError ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {researchError}
        </p>
      ) : null}

      {clarificationReview ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-white p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-amber-950">Founder clarification queue</p>
              <p className="mt-1 max-w-2xl text-xs text-amber-900/75">
                {interviewClarifications
                  ? 'Staff answers remain evidence, not venue truth. Clarifications guide a later source amendment and cannot create a package, approve, apply, publish, or contact the venue.'
                  : 'Public website claims are evidence, not venue truth. Answers guide a later explicit mapping review and cannot create a package, approve, apply, publish, or contact the venue.'}
              </p>
            </div>
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">
              {clarificationReview.clarifications.length} clarification
              {clarificationReview.clarifications.length === 1 ? '' : 's'}
            </span>
          </div>

          <ul className="mt-3 space-y-3">
            {clarificationReview.clarifications.map((clarification) => (
              <li
                key={
                  'discrepancyId' in clarification
                    ? clarification.discrepancyId
                    : clarification.clarificationId
                }
                className="rounded-lg border border-slate-200 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="break-all text-sm font-semibold text-pf-deep">
                    {clarification.fieldPath}
                  </p>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-pf-deep/70">
                    {clarification.question?.status.toLowerCase() ?? 'not queued'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-pf-deep/75">
                  {('reason' in clarification
                    ? clarification.reason
                    : clarification.reasons.join(', ')
                  )
                    .replaceAll('_', ' ')
                    .toLowerCase()}
                </p>
                <ul className="mt-2 space-y-1 text-xs text-pf-deep/75">
                  {clarification.evidence.map((evidence) => (
                    <li key={`${evidence.reference}:${evidence.summary}`}>
                      {/^https?:\/\//u.test(evidence.reference) ? (
                        <a
                          href={evidence.reference}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-pf-primary underline decoration-pf-primary/30 underline-offset-2"
                        >
                          {evidence.label}
                        </a>
                      ) : (
                        <span className="font-medium text-pf-deep">{evidence.label}</span>
                      )}
                      {evidence.summary ? ` · ${evidence.summary}` : ''}
                    </li>
                  ))}
                </ul>
                {clarification.question?.status === 'ANSWERED' ? (
                  <p className="mt-2 rounded-md bg-sky-50 p-2 text-xs text-sky-950">
                    Answer retained as guidance only: {clarification.question.answer}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {onCreateClarificationQuestions &&
          clarificationReview.clarifications.some(({ question }) => !question) ? (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex-1 text-xs font-medium text-pf-deep">
                Content identity
                <select
                  value={clarificationIdentityId}
                  onChange={(event) => onClarificationIdentityChange?.(event.target.value)}
                  className="mt-1 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3 text-sm"
                >
                  <option value="">Choose an in-scope identity</option>
                  {clarificationReview.eligibleIdentities.map((identity) => (
                    <option key={identity.id} value={identity.id}>
                      {identity.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={clarificationBusy || !clarificationIdentityId}
                onClick={onCreateClarificationQuestions}
                className="min-h-11 rounded-full bg-amber-700 px-5 text-sm font-semibold text-white transition-colors hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              >
                {clarificationBusy ? 'Retaining questions…' : 'Queue founder clarification'}
              </button>
            </div>
          ) : null}
          {clarificationError ? (
            <p className="mt-2 text-sm text-rose-700" role="alert">
              {clarificationError}
            </p>
          ) : null}
        </div>
      ) : null}

      {lifecycle.websiteClarificationReview && mappingGroups.length > 0 && !mappingComplete ? (
        <div className="mt-4 rounded-xl border border-sky-200 bg-white p-3">
          <p className="text-sm font-semibold text-sky-950">Reviewed website mapping</p>
          <p className="mt-1 max-w-2xl text-xs text-sky-900/75">
            Choose exact cited claims, preview the resulting Venue Package, then confirm a DRAFT.
            This does not approve, apply, or publish it.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {mappingGroups.map(([fieldPath, options]) => {
              const blocked = lifecycle.websiteClarificationReview!.clarifications.some(
                (clarification) =>
                  clarification.fieldPath === fieldPath &&
                  clarification.question?.status !== 'ANSWERED',
              )
              return (
                <label key={fieldPath} className="text-xs font-medium text-pf-deep">
                  {fieldPath}
                  <select
                    value={mappingSelections[fieldPath] ?? ''}
                    disabled={blocked || mappingBusy}
                    onChange={(event) => onMappingSelectionChange?.(fieldPath, event.target.value)}
                    className="mt-1 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3 text-sm disabled:bg-slate-100 disabled:text-slate-500"
                  >
                    <option value="">
                      {blocked ? 'Answer founder clarification first' : 'Do not map this field'}
                    </option>
                    {options.map((option) => (
                      <option key={option.evidenceId} value={option.evidenceId}>
                        {option.value} · {Math.round(option.confidence * 100)}%
                      </option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
          {onPreviewWebsiteMapping ? (
            <button
              type="button"
              disabled={mappingBusy || !Object.values(mappingSelections).some(Boolean)}
              onClick={onPreviewWebsiteMapping}
              className="mt-3 min-h-11 rounded-full border border-sky-700 px-5 text-sm font-semibold text-sky-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mappingBusy ? 'Checking mapping…' : 'Preview reviewed mapping'}
            </button>
          ) : null}
          {mappingPreview ? (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-sm font-semibold text-emerald-950">Exact DRAFT preview is ready</p>
              <p className="mt-1 text-xs text-emerald-900/75">
                {mappingPreview.selections.length} mapped field
                {mappingPreview.selections.length === 1 ? '' : 's'} · no approval, apply, or
                publication authority.
              </p>
              <label className="mt-3 flex min-h-11 items-start gap-2 text-sm text-emerald-950">
                <input
                  type="checkbox"
                  checked={mappingReviewed}
                  onChange={(event) => onMappingReviewedChange?.(event.target.checked)}
                  className="mt-1 size-4"
                />
                <span>I reviewed these exact citations and want to create a linked DRAFT.</span>
              </label>
              {onCreateWebsiteMappingDraft ? (
                <button
                  type="button"
                  disabled={!mappingReviewed || mappingBusy}
                  onClick={onCreateWebsiteMappingDraft}
                  className="mt-2 min-h-11 rounded-full bg-emerald-800 px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {mappingBusy ? 'Creating DRAFT…' : 'Create linked Venue Package DRAFT'}
                </button>
              ) : null}
            </div>
          ) : null}
          {mappingError ? (
            <p className="mt-2 text-sm text-rose-700" role="alert">
              {mappingError}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-pf-deep/75">
        This view is evidence-derived. Approval, apply, and publication remain separate human
        actions.
      </p>
    </section>
  )
}
