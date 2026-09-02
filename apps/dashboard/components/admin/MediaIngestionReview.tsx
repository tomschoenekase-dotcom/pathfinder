'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

type MediaProject = inferRouterOutputs<AppRouter>['mediaIngestion']['get']
type MediaAsset = MediaProject['assets'][number]
type Question = { id: string; question: string; answer: string }
type FindingReview = {
  summary: string
  uncertainties: string[]
  note: string
  reviewedBy: string
  reviewedAt: string
}
type Finding = {
  sourceId: string
  filename: string
  mediaType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT'
  summary: string
  uncertainties: string[]
  review?: FindingReview
}
type FindingEdit = { summary: string; uncertainties: string; note: string }
type FindingCorrection = {
  sourceId: string
  summary: string
  uncertainties: string[]
  note: string
}
const REVIEW_READ_TIMEOUT_MS = 15_000

function normalizeQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const question = item as Record<string, unknown>
    if (typeof question.id !== 'string' || typeof question.question !== 'string') return []
    return [
      {
        id: question.id,
        question: question.question,
        answer: typeof question.answer === 'string' ? question.answer : '',
      },
    ]
  })
}

function normalizeFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const finding = item as Record<string, unknown>
    if (
      typeof finding.sourceId !== 'string' ||
      typeof finding.filename !== 'string' ||
      !['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'].includes(String(finding.mediaType)) ||
      typeof finding.summary !== 'string' ||
      !Array.isArray(finding.uncertainties) ||
      !finding.uncertainties.every((entry) => typeof entry === 'string')
    ) {
      return []
    }
    const rawReview = finding.review
    let review: FindingReview | undefined
    if (rawReview && typeof rawReview === 'object') {
      const candidate = rawReview as Record<string, unknown>
      if (
        typeof candidate.summary === 'string' &&
        Array.isArray(candidate.uncertainties) &&
        candidate.uncertainties.every((entry) => typeof entry === 'string') &&
        typeof candidate.note === 'string' &&
        typeof candidate.reviewedBy === 'string' &&
        typeof candidate.reviewedAt === 'string'
      ) {
        review = candidate as FindingReview
      }
    }
    return [
      {
        sourceId: finding.sourceId,
        filename: finding.filename,
        mediaType: finding.mediaType as Finding['mediaType'],
        summary: finding.summary,
        uncertainties: finding.uncertainties as string[],
        ...(review ? { review } : {}),
      },
    ]
  })
}

function initialFindingEdits(findings: Finding[]): Record<string, FindingEdit> {
  return Object.fromEntries(
    findings.map((finding) => [
      finding.sourceId,
      {
        summary: finding.review?.summary ?? finding.summary,
        uncertainties: (finding.review?.uncertainties ?? finding.uncertainties).join('\n'),
        note: finding.review?.note ?? '',
      },
    ]),
  )
}

function collectFindingCorrections(
  findings: Finding[],
  findingEdits: Record<string, FindingEdit>,
): FindingCorrection[] {
  return findings.flatMap((finding) => {
    const edit = findingEdits[finding.sourceId]
    if (!edit) return []
    const uncertainties = edit.uncertainties
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
    const baselineSummary = finding.review?.summary ?? finding.summary
    const baselineUncertainties = finding.review?.uncertainties ?? finding.uncertainties
    const baselineNote = finding.review?.note ?? ''
    const unchanged =
      edit.summary === baselineSummary &&
      edit.note === baselineNote &&
      uncertainties.length === baselineUncertainties.length &&
      uncertainties.every((entry, index) => entry === baselineUncertainties[index])
    return unchanged
      ? []
      : [{ sourceId: finding.sourceId, summary: edit.summary, uncertainties, note: edit.note }]
  })
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

export function MediaIngestionReview({ initialProject }: { initialProject: MediaProject }) {
  const client = useTRPCClient()
  const [findings, setFindings] = useState(() => normalizeFindings(initialProject.findings))
  const [findingsNextCursor, setFindingsNextCursor] = useState(initialProject.findingsNextCursor)
  const [findingPageCursor, setFindingPageCursor] = useState<string | null>(null)
  const [previousFindingCursors, setPreviousFindingCursors] = useState<Array<string | null>>([])
  const [questions, setQuestions] = useState(() => normalizeQuestions(initialProject.questions))
  const [findingEdits, setFindingEdits] = useState(() => initialFindingEdits(findings))
  const [assets, setAssets] = useState<MediaAsset[]>(initialProject.assets)
  const [assetNextCursor, setAssetNextCursor] = useState<string | null>(
    initialProject.assetsTruncated ? (initialProject.assets.at(-1)?.id ?? null) : null,
  )
  const [updatedAt, setUpdatedAt] = useState(initialProject.updatedAt)
  const [draftText, setDraftText] = useState(() =>
    JSON.stringify(initialProject.draftJson ?? {}, null, 2),
  )
  const [busy, setBusy] = useState(false)
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [loadingFindings, setLoadingFindings] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const saveInFlightRef = useRef(false)
  const assetRequestRef = useRef<AbortController | null>(null)
  const findingRequestRef = useRef<AbortController | null>(null)
  const parseError = useMemo(() => {
    try {
      const value = JSON.parse(draftText)
      return VenuePackagePayloadV1.safeParse(value).success
        ? null
        : 'The draft does not match the Venue Package v1 contract.'
    } catch {
      return 'The draft is not valid JSON.'
    }
  }, [draftText])
  const assetsBySource = useMemo(
    () => new Map(assets.map((asset) => [asset.sourceId, asset])),
    [assets],
  )
  const pendingFindingCorrections = useMemo(
    () => collectFindingCorrections(findings, findingEdits),
    [findings, findingEdits],
  )

  useEffect(
    () => () => {
      mountedRef.current = false
      assetRequestRef.current?.abort()
      findingRequestRef.current?.abort()
    },
    [],
  )

  async function save() {
    if (parseError || saveInFlightRef.current) return
    saveInFlightRef.current = true
    setBusy(true)
    setMessage(null)
    try {
      const result = await client.mediaIngestion.saveReview.mutate({
        tenantId: initialProject.tenantId,
        venueId: initialProject.venueId,
        projectId: initialProject.id,
        reviewGeneration: initialProject.reviewGeneration,
        expectedUpdatedAt: updatedAt,
        questionAnswers: questions.map(({ id, answer }) => ({ id, answer })),
        findingCorrections: pendingFindingCorrections,
        draftJson: JSON.parse(draftText),
      })
      if (!mountedRef.current) return
      setUpdatedAt(result.updatedAt)
      const reviewsBySource = new Map(
        result.findingReviews.map((finding) => [finding.sourceId, finding.review]),
      )
      const savedFindings = findings.map((finding) => {
        const review = reviewsBySource.get(finding.sourceId)
        return review ? { ...finding, review } : finding
      })
      setFindings(savedFindings)
      setFindingEdits(initialFindingEdits(savedFindings))
      setQuestions(normalizeQuestions(result.questions))
      setMessage(
        result.status === 'NEEDS_INPUT'
          ? 'Review saved. Unanswered questions remain.'
          : 'Review saved and ready.',
      )
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : 'Could not save the review.')
      }
    } finally {
      saveInFlightRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  async function loadMoreAssets() {
    if (!assetNextCursor || assetRequestRef.current) return
    const controller = new AbortController()
    assetRequestRef.current = controller
    setLoadingAssets(true)
    setMessage(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: REVIEW_READ_TIMEOUT_MS,
        request: (signal) =>
          client.mediaIngestion.listAssets.query(
            {
              tenantId: initialProject.tenantId,
              venueId: initialProject.venueId,
              projectId: initialProject.id,
              reviewGeneration: initialProject.reviewGeneration,
              cursor: assetNextCursor,
              limit: 50,
            },
            { signal },
          ),
      })
      if (controller.signal.aborted) return
      setAssets((current) => [...current, ...result.items])
      setAssetNextCursor(result.nextCursor)
    } catch {
      if (!controller.signal.aborted) {
        setMessage('Could not load more source evidence. Retry from the last confirmed page.')
      }
    } finally {
      if (assetRequestRef.current === controller) {
        assetRequestRef.current = null
        if (mountedRef.current) setLoadingAssets(false)
      }
    }
  }

  async function loadFindingPage(cursor: string | null): Promise<boolean> {
    if (findingRequestRef.current) return false
    if (pendingFindingCorrections.length > 0) {
      setMessage('Save or discard this page\u2019s finding edits before changing pages.')
      return false
    }
    const controller = new AbortController()
    findingRequestRef.current = controller
    setLoadingFindings(true)
    setMessage(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: REVIEW_READ_TIMEOUT_MS,
        request: (signal) =>
          client.mediaIngestion.listFindings.query(
            {
              tenantId: initialProject.tenantId,
              venueId: initialProject.venueId,
              projectId: initialProject.id,
              reviewGeneration: initialProject.reviewGeneration,
              ...(cursor ? { cursor } : {}),
            },
            { signal },
          ),
      })
      if (controller.signal.aborted) return false
      const page = normalizeFindings(result.items)
      setFindings(page)
      setFindingEdits(initialFindingEdits(page))
      setFindingsNextCursor(result.nextCursor)
      return true
    } catch {
      if (!controller.signal.aborted) {
        setMessage('Could not load source findings. Retry from the last confirmed page.')
      }
      return false
    } finally {
      if (findingRequestRef.current === controller) {
        findingRequestRef.current = null
        if (mountedRef.current) setLoadingFindings(false)
      }
    }
  }

  async function loadNextFindingPage() {
    if (!findingsNextCursor) return
    const target = findingsNextCursor
    if (await loadFindingPage(target)) {
      setPreviousFindingCursors((current) => [...current, findingPageCursor])
      setFindingPageCursor(target)
    }
  }

  async function loadPreviousFindingPage() {
    const target = previousFindingCursors.at(-1)
    if (target === undefined) return
    if (await loadFindingPage(target)) {
      setPreviousFindingCursors((current) => current.slice(0, -1))
      setFindingPageCursor(target)
    }
  }

  function download() {
    if (parseError) return
    const blob = new Blob([draftText], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'torchiko-venue-package-v1.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Questions for you</h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          Unanswered questions remain explicitly unresolved and keep this intake in needs-input
          state.
        </p>
        {questions.length === 0 ? (
          <p className="mt-5 rounded-lg bg-pf-surface px-4 py-3 text-sm text-pf-deep/60">
            No blocking questions were generated.
          </p>
        ) : (
          <div className="mt-5 space-y-4">
            {questions.map((question, index) => (
              <label key={question.id} className="block text-sm font-medium text-pf-deep/75">
                {question.question}
                <textarea
                  rows={3}
                  value={question.answer}
                  onChange={(event) =>
                    setQuestions((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, answer: event.target.value } : item,
                      ),
                    )
                  }
                  className="mt-2 w-full rounded-lg border border-pf-light bg-pf-surface px-4 py-3 font-normal outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                />
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Source evidence</h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          Corrected summaries are retained beside the original AI evidence. They do not silently
          rewrite the venue-package draft; edit that draft separately below.
        </p>
        {findings.length === 0 ? (
          <p className="mt-5 rounded-lg bg-pf-surface px-4 py-3 text-sm text-pf-deep/60">
            No source findings are available.
          </p>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {findings.map((finding) => {
              const edit = findingEdits[finding.sourceId]!
              const asset = assetsBySource.get(finding.sourceId)
              return (
                <article key={finding.sourceId} className="rounded-xl border border-pf-light p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-pf-deep">{finding.filename}</h3>
                      <p className="text-xs text-pf-deep/55">
                        {finding.mediaType}
                        {asset
                          ? ` · ${humanBytes(asset.bytes)} · ${asset.status.toLowerCase()}`
                          : ''}
                      </p>
                    </div>
                    {finding.review ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                        corrected
                      </span>
                    ) : null}
                  </div>
                  <details className="mt-3 text-sm text-pf-deep/65">
                    <summary className="cursor-pointer font-medium">Original AI finding</summary>
                    <p className="mt-2 whitespace-pre-wrap">{finding.summary}</p>
                    {finding.uncertainties.length > 0 ? (
                      <ul className="mt-2 list-disc pl-5">
                        {finding.uncertainties.map((uncertainty) => (
                          <li key={uncertainty}>{uncertainty}</li>
                        ))}
                      </ul>
                    ) : null}
                  </details>
                  <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-pf-deep/55">
                    Corrected summary
                    <textarea
                      rows={4}
                      value={edit.summary}
                      onChange={(event) =>
                        setFindingEdits((current) => ({
                          ...current,
                          [finding.sourceId]: { ...edit, summary: event.target.value },
                        }))
                      }
                      className="mt-2 w-full rounded-lg border border-pf-light bg-pf-surface px-3 py-2 text-sm font-normal normal-case tracking-normal outline-none focus:border-pf-accent"
                    />
                  </label>
                  <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-pf-deep/55">
                    Uncertainties, one per line
                    <textarea
                      rows={3}
                      value={edit.uncertainties}
                      onChange={(event) =>
                        setFindingEdits((current) => ({
                          ...current,
                          [finding.sourceId]: { ...edit, uncertainties: event.target.value },
                        }))
                      }
                      className="mt-2 w-full rounded-lg border border-pf-light bg-pf-surface px-3 py-2 text-sm font-normal normal-case tracking-normal outline-none focus:border-pf-accent"
                    />
                  </label>
                  <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-pf-deep/55">
                    Reviewer note
                    <textarea
                      rows={2}
                      value={edit.note}
                      onChange={(event) =>
                        setFindingEdits((current) => ({
                          ...current,
                          [finding.sourceId]: { ...edit, note: event.target.value },
                        }))
                      }
                      className="mt-2 w-full rounded-lg border border-pf-light bg-pf-surface px-3 py-2 text-sm font-normal normal-case tracking-normal outline-none focus:border-pf-accent"
                    />
                  </label>
                  {asset?.error ? (
                    <p className="mt-3 text-sm text-rose-700">{asset.error}</p>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          {previousFindingCursors.length > 0 ? (
            <button
              type="button"
              onClick={() => void loadPreviousFindingPage()}
              disabled={loadingFindings}
              className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary hover:border-pf-accent disabled:opacity-40"
            >
              Previous findings
            </button>
          ) : null}
          {findingsNextCursor ? (
            <button
              type="button"
              onClick={() => void loadNextFindingPage()}
              disabled={loadingFindings}
              className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary hover:border-pf-accent disabled:opacity-40"
            >
              {loadingFindings ? 'Loading\u2026' : 'Next findings'}
            </button>
          ) : null}
        </div>
        {assetNextCursor ? (
          <button
            type="button"
            onClick={() => void loadMoreAssets()}
            disabled={loadingAssets}
            className="mt-5 rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary hover:border-pf-accent disabled:opacity-40"
          >
            {loadingAssets ? 'Loading…' : 'Load more source metadata'}
          </button>
        ) : null}
      </section>

      <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
              Venue package JSON
            </h2>
            <p className="mt-2 text-sm text-pf-deep/60">
              This is validated by the server against the frozen Venue Package v1 contract.
            </p>
          </div>
          <button
            type="button"
            onClick={download}
            disabled={Boolean(parseError)}
            className="rounded-full border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary hover:border-pf-accent disabled:opacity-40"
          >
            Download JSON
          </button>
        </div>
        <textarea
          value={draftText}
          onChange={(event) => setDraftText(event.target.value)}
          spellCheck={false}
          className="mt-5 min-h-[34rem] w-full rounded-lg border border-pf-light bg-pf-surface px-4 py-3 font-mono text-xs leading-5 outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
        {parseError ? <p className="mt-2 text-sm text-rose-700">{parseError}</p> : null}
      </section>

      <div className="flex items-center justify-end gap-4">
        {message ? <span className="text-sm text-pf-deep/60">{message}</span> : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || Boolean(parseError)}
          className="rounded-full bg-pf-primary px-6 py-3 text-sm font-semibold text-white hover:bg-pf-accent disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save review'}
        </button>
      </div>
    </div>
  )
}
