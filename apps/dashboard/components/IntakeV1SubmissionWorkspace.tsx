'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { browserUuid } from '../lib/browser-uuid'
import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { useTRPCClient } from '../lib/trpc'
import {
  IntakeProposalWorkspace,
  type IntakeProposalSummary,
  type IntakeProposalWorkspaceController,
} from './IntakeProposalWorkspace'
import {
  IntakeV1ReviewPanel,
  type IntakeV1ReviewReceipt,
  type IntakeV1ReviewSource,
} from './IntakeV1ReviewPanel'
import { IntakeV1ProcessingStatus } from './IntakeV1ProcessingStatus'

const QUERY_TIMEOUT_MS = 15_000
const MUTATION_TIMEOUT_MS = 15_000

type Cursor = { createdAt: string; id: string }
type Candidate = {
  id: string
  displayName: string
  sourceKind?: string | null
  status: string
  createdAt: Date | string
}
type UploadCandidate = Candidate & { intakeRunId: string | null }
type CurrentMember = {
  kind: 'INTAKE_RUN' | 'INTAKE_UPLOAD'
  intakeRunId: string | null
  intakeUploadId: string | null
  displayName: string | null
  sourceKind: string | null
  linkedIntakeRunId: string | null
}
type LatestSubmission = {
  id: string
  status: string
  revision: number
  revisions: Array<{
    revision: number
    criticalMissing: unknown
    members: CurrentMember[]
  }>
}
type FrozenReview = {
  sources: IntakeV1ReviewSource[]
  uploadRunLinks: Record<string, string>
  drafts: Array<{
    sourceKind: 'WEBSITE' | 'INTERVIEW' | 'NOTES'
    expectedRevision: number
  }>
  base: { submissionId: string; revision: number } | null
}
type StoredRetry = {
  version: 1
  operationId: string
  selectedKeys: string[]
  partialAcknowledged: boolean
  base: FrozenReview['base']
  drafts: FrozenReview['drafts']
}

const sourceKey = (id: string) => `source:${id}`
const uploadKey = (id: string) => `upload:${id}`
const draftKey = (kind: string) => `draft:${kind}`

function sourceKindLabel(kind: string | null | undefined): string {
  if (kind === 'WEBSITE') return 'Website'
  if (kind === 'INTERVIEW') return 'Staff answers'
  if (kind === 'STRUCTURED_BOOTSTRAP' || kind === 'NOTES') return 'Shared notes'
  if (kind === 'FILE_UPLOAD') return 'Uploaded file'
  return 'Shared information'
}

function reviewStatusLabel(status: string): string {
  if (status === 'AWAITING_REVIEW') return 'Review pending'
  if (status === 'CLEAN') return 'Verified upload'
  return 'Shared for review'
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const data = (error as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  return typeof (data as { code?: unknown }).code === 'string'
    ? ((data as { code: string }).code ?? null)
    : null
}

const DEFINITIVE_ERROR_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
])

function exclusions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 50).map((item) => {
    const code =
      item && typeof item === 'object' && typeof (item as { code?: unknown }).code === 'string'
        ? (item as { code: string }).code
        : 'SOURCE_UNAVAILABLE'
    return code.replaceAll('_', ' ').toLowerCase()
  })
}

function currentRevision(submission: LatestSubmission | null) {
  return submission?.revisions.find((revision) => revision.revision === submission.revision) ?? null
}

function storedRetry(value: string | null): StoredRetry | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<StoredRetry>
    if (
      parsed.version !== 1 ||
      typeof parsed.operationId !== 'string' ||
      !/^[0-9a-f-]{36}$/iu.test(parsed.operationId) ||
      !Array.isArray(parsed.selectedKeys) ||
      parsed.selectedKeys.length > 50 ||
      !parsed.selectedKeys.every(
        (key) =>
          typeof key === 'string' &&
          /^(draft:(WEBSITE|INTERVIEW|NOTES)|(?:source|upload):[^:]{1,191})$/u.test(key),
      ) ||
      typeof parsed.partialAcknowledged !== 'boolean' ||
      !Array.isArray(parsed.drafts) ||
      parsed.drafts.length > 3 ||
      !parsed.drafts.every(
        (draft) =>
          draft &&
          typeof draft === 'object' &&
          ['WEBSITE', 'INTERVIEW', 'NOTES'].includes(draft.sourceKind) &&
          Number.isInteger(draft.expectedRevision) &&
          draft.expectedRevision > 0,
      ) ||
      (parsed.base !== null &&
        (typeof parsed.base !== 'object' ||
          typeof parsed.base?.submissionId !== 'string' ||
          parsed.base.submissionId.length < 1 ||
          parsed.base.submissionId.length > 191 ||
          !Number.isInteger(parsed.base.revision) ||
          parsed.base.revision < 1))
    )
      return null
    return parsed as StoredRetry
  } catch {
    return null
  }
}

export function IntakeV1SubmissionWorkspace({
  ownerId,
  venueId,
  proposals,
}: {
  ownerId: string
  venueId: string
  proposals: IntakeProposalSummary[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const draftController = useRef<IntakeProposalWorkspaceController>(null)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const queryScope = useRef(new AbortController())
  const clientRef = useRef(client)
  const venueRef = useRef(venueId)
  const ownerIdRef = useRef(ownerId)
  const mutationRef = useRef<Promise<void> | null>(null)
  const preservedKeysRef = useRef<Set<string> | null>(null)
  clientRef.current = client
  venueRef.current = venueId
  ownerIdRef.current = ownerId

  const [phase, setPhase] = useState<'editing' | 'preparing' | 'reviewing' | 'submitting'>(
    'editing',
  )
  const [loadingReceipt, setLoadingReceipt] = useState(true)
  const [review, setReview] = useState<FrozenReview | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [partialAcknowledged, setPartialAcknowledged] = useState(false)
  const [operationId, setOperationId] = useState(browserUuid)
  const [retryUncertain, setRetryUncertain] = useState(false)
  const [receipt, setReceipt] = useState<IntakeV1ReviewReceipt | null>(null)
  const [processingTarget, setProcessingTarget] = useState<{
    submissionId: string
    revision: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceCursor, setSourceCursor] = useState<Cursor | null>(null)
  const [uploadCursor, setUploadCursor] = useState<Cursor | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [draftWorkspaceKey, setDraftWorkspaceKey] = useState(0)

  const storageKey = `torchiko:intake-v1:${ownerId}:${venueId}`
  const scopeCurrent = useCallback(
    (generation: number) =>
      mountedRef.current &&
      generationRef.current === generation &&
      clientRef.current === client &&
      venueRef.current === venueId &&
      ownerIdRef.current === ownerId,
    [client, ownerId, venueId],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    queryScope.current = controller
    const generation = ++generationRef.current
    mutationRef.current = null
    preservedKeysRef.current = null
    setPhase('editing')
    setReview(null)
    setSelectedKeys(new Set())
    setPartialAcknowledged(false)
    setOperationId(browserUuid())
    setRetryUncertain(false)
    setReceipt(null)
    setProcessingTarget(null)
    setError(null)
    setSourceCursor(null)
    setUploadCursor(null)
    setLoadingMore(false)
    setLoadingReceipt(true)
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: QUERY_TIMEOUT_MS,
      request: (signal) =>
        client.intake.getLatestV1.query({ venueId, revisionLimit: 1 }, { signal }),
    })
      .then((result) => {
        if (!scopeCurrent(generation)) return
        const next = result as LatestSubmission | null
        const revision = currentRevision(next)
        if (revision) setProcessingTarget({ submissionId: next!.id, revision: revision.revision })
        if (revision)
          setReceipt({
            revision: revision.revision,
            includedCount: revision.members.length,
            excludedDescriptions: exclusions(revision.criticalMissing),
          })
      })
      .catch(() => {
        if (scopeCurrent(generation)) setError('Could not load your latest saved submission.')
      })
      .finally(() => {
        if (scopeCurrent(generation)) setLoadingReceipt(false)
      })
    return () => {
      controller.abort()
    }
  }, [client, scopeCurrent, ownerId, venueId])

  const persistRetry = useCallback(
    (value: StoredRetry | null) => {
      if (!storageKey) return
      try {
        if (value) sessionStorage.setItem(storageKey, JSON.stringify(value))
        else sessionStorage.removeItem(storageKey)
      } catch {
        // Storage can be unavailable without weakening the in-memory retry fence.
      }
    },
    [storageKey],
  )

  useEffect(() => {
    if (!storageKey) return
    let restored: StoredRetry | null = null
    try {
      restored = storedRetry(sessionStorage.getItem(storageKey))
    } catch {
      return
    }
    if (!restored) return
    setOperationId(restored.operationId)
    setSelectedKeys(new Set(restored.selectedKeys))
    setPartialAcknowledged(restored.partialAcknowledged)
    setReview({ sources: [], uploadRunLinks: {}, drafts: restored.drafts, base: restored.base })
    setRetryUncertain(true)
    setPhase('reviewing')
    setError('A prior submission may have been received. Check the same submission again.')
  }, [client, storageKey])

  const renewOperation = useCallback(() => {
    setOperationId(browserUuid())
    setRetryUncertain(false)
    persistRetry(null)
  }, [persistRetry])

  async function prepare() {
    if (phase !== 'editing' || !draftController.current) return
    const generation = generationRef.current
    setPhase('preparing')
    setError(null)
    try {
      const [drafts, sourcePage, uploadPage, latestResult] = await Promise.all([
        draftController.current.prepareV1Drafts(),
        runBoundedClientRequest({
          parentSignal: queryScope.current.signal,
          timeoutMs: QUERY_TIMEOUT_MS,
          request: (signal) =>
            client.intake.listV1Candidates.query({ venueId, limit: 25 }, { signal }),
        }),
        runBoundedClientRequest({
          parentSignal: queryScope.current.signal,
          timeoutMs: QUERY_TIMEOUT_MS,
          request: (signal) =>
            client.intake.listV1UploadCandidates.query({ venueId, limit: 25 }, { signal }),
        }),
        runBoundedClientRequest({
          parentSignal: queryScope.current.signal,
          timeoutMs: QUERY_TIMEOUT_MS,
          request: (signal) =>
            client.intake.getLatestV1.query({ venueId, revisionLimit: 1 }, { signal }),
        }),
      ])
      if (!scopeCurrent(generation)) return
      const nextLatest = latestResult as LatestSubmission | null
      const prior = currentRevision(nextLatest)
      const sources = new Map<string, IntakeV1ReviewSource>()
      const uploadRunLinks: Record<string, string> = {}
      for (const draft of drafts)
        sources.set(draftKey(draft.sourceKind), {
          key: draftKey(draft.sourceKind),
          group: 'draft',
          label: `${sourceKindLabel(draft.sourceKind)} draft`,
          detail: 'Saved privately and included only in this reviewed version.',
        })
      for (const item of sourcePage.items as Candidate[])
        sources.set(sourceKey(item.id), {
          key: sourceKey(item.id),
          group: 'source',
          label: item.displayName,
          detail: `${sourceKindLabel(item.sourceKind)} · ${reviewStatusLabel(item.status)}`,
        })
      for (const item of uploadPage.items as UploadCandidate[]) {
        if (item.intakeRunId) uploadRunLinks[item.id] = item.intakeRunId
        sources.set(uploadKey(item.id), {
          key: uploadKey(item.id),
          group: 'upload',
          label: item.displayName,
          detail: reviewStatusLabel(item.status),
        })
      }
      for (const member of prior?.members ?? []) {
        const id = member.intakeRunId ?? member.intakeUploadId
        if (!id) continue
        const key = member.kind === 'INTAKE_RUN' ? sourceKey(id) : uploadKey(id)
        sources.set(key, {
          key,
          group: member.kind === 'INTAKE_RUN' ? 'source' : 'upload',
          label: member.displayName ?? 'Previously selected material',
          detail: 'Included in the current saved version.',
        })
        if (member.kind === 'INTAKE_UPLOAD' && member.intakeUploadId && member.linkedIntakeRunId)
          uploadRunLinks[member.intakeUploadId] = member.linkedIntakeRunId
      }
      const all = [...sources.values()]
      const defaultSelection = new Set<string>()
      const preserved = preservedKeysRef.current
      if (preserved) {
        for (const key of preserved) if (sources.has(key)) defaultSelection.add(key)
        preservedKeysRef.current = null
      } else if (prior) {
        for (const member of prior.members) {
          if (defaultSelection.size >= 50) break
          const id = member.intakeRunId ?? member.intakeUploadId
          if (id) defaultSelection.add(member.kind === 'INTAKE_RUN' ? sourceKey(id) : uploadKey(id))
        }
        for (const draft of drafts) {
          if (defaultSelection.size >= 50) break
          defaultSelection.add(draftKey(draft.sourceKind))
        }
      } else {
        for (const source of all.filter(
          (item) =>
            item.group !== 'upload' ||
            uploadPage.items.some(
              (upload: UploadCandidate) =>
                uploadKey(upload.id) === item.key && upload.status === 'AWAITING_REVIEW',
            ),
        )) {
          if (defaultSelection.size >= 50) break
          defaultSelection.add(source.key)
        }
        for (const upload of uploadPage.items as UploadCandidate[])
          if (upload.intakeRunId && defaultSelection.has(sourceKey(upload.intakeRunId)))
            defaultSelection.delete(uploadKey(upload.id))
      }
      const frozen = {
        sources: all,
        uploadRunLinks,
        drafts,
        base: nextLatest ? { submissionId: nextLatest.id, revision: nextLatest.revision } : null,
      }
      setReview(frozen)
      setSelectedKeys(defaultSelection)
      setSourceCursor(sourcePage.nextCursor)
      setUploadCursor(uploadPage.nextCursor)
      setPartialAcknowledged(false)
      renewOperation()
      setPhase('reviewing')
    } catch {
      if (scopeCurrent(generation)) {
        setError('Could not prepare your saved materials. Your private drafts remain saved.')
        setPhase('editing')
      }
    }
  }

  async function loadMore(kind: 'source' | 'upload') {
    if (!review || loadingMore) return
    const cursor = kind === 'source' ? sourceCursor : uploadCursor
    if (!cursor) return
    const generation = generationRef.current
    setLoadingMore(true)
    try {
      const page =
        kind === 'source'
          ? await runBoundedClientRequest({
              parentSignal: queryScope.current.signal,
              timeoutMs: QUERY_TIMEOUT_MS,
              request: (signal) =>
                client.intake.listV1Candidates.query({ venueId, limit: 25, cursor }, { signal }),
            })
          : await runBoundedClientRequest({
              parentSignal: queryScope.current.signal,
              timeoutMs: QUERY_TIMEOUT_MS,
              request: (signal) =>
                client.intake.listV1UploadCandidates.query(
                  { venueId, limit: 25, cursor },
                  { signal },
                ),
            })
      if (!scopeCurrent(generation)) return
      const additions = (page.items as Array<Candidate | UploadCandidate>).map((item) => ({
        key: kind === 'source' ? sourceKey(item.id) : uploadKey(item.id),
        group: kind,
        label: item.displayName,
        detail: reviewStatusLabel(item.status),
      })) satisfies IntakeV1ReviewSource[]
      setReview((current) =>
        current
          ? {
              ...current,
              uploadRunLinks:
                kind === 'upload'
                  ? {
                      ...current.uploadRunLinks,
                      ...Object.fromEntries(
                        (page.items as UploadCandidate[])
                          .filter((item) => item.intakeRunId)
                          .map((item) => [item.id, item.intakeRunId!]),
                      ),
                    }
                  : current.uploadRunLinks,
              sources: [
                ...current.sources,
                ...additions.filter(
                  (addition) => !current.sources.some((source) => source.key === addition.key),
                ),
              ],
            }
          : current,
      )
      if (kind === 'source') setSourceCursor(page.nextCursor)
      else setUploadCursor(page.nextCursor)
    } catch {
      if (scopeCurrent(generation)) setError('Could not load more materials. Try again.')
    } finally {
      if (scopeCurrent(generation)) setLoadingMore(false)
    }
  }

  function toggleSelection(key: string) {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else if (next.size < 50) {
        next.add(key)
        if (key.startsWith('upload:')) {
          const uploadId = key.slice('upload:'.length)
          const linkedRunId = review?.uploadRunLinks[uploadId]
          if (linkedRunId) next.delete(sourceKey(linkedRunId))
        } else if (key.startsWith('source:')) {
          const runId = key.slice('source:'.length)
          for (const [uploadId, linkedRunId] of Object.entries(review?.uploadRunLinks ?? {}))
            if (linkedRunId === runId) next.delete(uploadKey(uploadId))
        }
      }
      return next
    })
    renewOperation()
  }

  function submit() {
    if (!review || loadingReceipt || mutationRef.current) return
    const generation = generationRef.current
    const frozenOperationId = operationId
    const frozenKeys = [...selectedKeys]
    const selection = {
      operationId: frozenOperationId,
      partialAcknowledged,
      drafts: Object.fromEntries(
        review.drafts
          .filter((draft) => selectedKeys.has(draftKey(draft.sourceKind)))
          .map((draft) => [
            draft.sourceKind,
            { include: true, expectedRevision: draft.expectedRevision },
          ]),
      ),
      intakeRunIds: frozenKeys
        .filter((key) => key.startsWith('source:'))
        .map((key) => key.slice(7)),
      intakeUploadIds: frozenKeys
        .filter((key) => key.startsWith('upload:'))
        .map((key) => key.slice(7)),
    }
    const retryRecord: StoredRetry = {
      version: 1,
      operationId: frozenOperationId,
      selectedKeys: frozenKeys,
      partialAcknowledged,
      base: review.base,
      drafts: review.drafts,
    }
    persistRetry(retryRecord)
    setPhase('submitting')
    setError(null)
    const mutation = (async () => {
      try {
        const result = await runBoundedClientRequest({
          parentSignal: queryScope.current.signal,
          timeoutMs: MUTATION_TIMEOUT_MS,
          request: (signal) =>
            review.base
              ? client.intake.amendV1.mutate(
                  {
                    venueId,
                    submissionId: review.base.submissionId,
                    expectedCurrentRevision: review.base.revision,
                    selection,
                  },
                  { signal },
                )
              : client.intake.submitV1.mutate({ venueId, selection }, { signal }),
        })
        if (!scopeCurrent(generation)) return
        const excludedDescriptions = exclusions(result.criticalMissing)
        setReceipt({
          revision: result.revision,
          includedCount: null,
          excludedDescriptions,
        })
        setProcessingTarget({ submissionId: result.submissionId, revision: result.revision })
        setDraftWorkspaceKey((value) => value + 1)
        setRetryUncertain(false)
        persistRetry(null)
        try {
          const exact = (await runBoundedClientRequest({
            parentSignal: queryScope.current.signal,
            timeoutMs: QUERY_TIMEOUT_MS,
            request: (signal) =>
              client.intake.getV1.query(
                {
                  venueId,
                  submissionId: result.submissionId,
                  revisionCursor: result.revision + 1,
                  revisionLimit: 1,
                },
                { signal },
              ),
          })) as LatestSubmission
          if (!scopeCurrent(generation)) return
          const revision = exact.revisions.find(
            (candidate) => candidate.revision === result.revision,
          )
          if (revision)
            setReceipt({
              revision: revision.revision,
              includedCount: revision.members.length,
              excludedDescriptions: exclusions(revision.criticalMissing),
            })
          setReview(null)
          setSelectedKeys(new Set())
          setPhase('editing')
          router.refresh()
        } catch {
          if (!scopeCurrent(generation)) return
          setPhase('editing')
          setError(
            'Your submission was saved, but its receipt could not reload. Reload this page to view it.',
          )
        }
      } catch (caught) {
        if (!scopeCurrent(generation)) return
        const code = errorCode(caught)
        if (code === 'CONFLICT') {
          setRetryUncertain(false)
          persistRetry(null)
          let refreshed: LatestSubmission | null = null
          try {
            refreshed = (await runBoundedClientRequest({
              parentSignal: queryScope.current.signal,
              timeoutMs: QUERY_TIMEOUT_MS,
              request: (signal) =>
                client.intake.getLatestV1.query({ venueId, revisionLimit: 1 }, { signal }),
            })) as LatestSubmission | null
            if (!scopeCurrent(generation)) return
          } catch {
            // The conflict remains safe even when refresh also fails.
          }
          if (review.base && refreshed?.revision !== review.base.revision) {
            preservedKeysRef.current = new Set(frozenKeys)
            renewOperation()
            setReview(null)
            setPhase('editing')
            setError(
              'This submission changed elsewhere. Review the refreshed materials before submitting again.',
            )
          } else {
            renewOperation()
            setPhase('reviewing')
            setError(
              'Some selected materials are incomplete or changed. Confirm “Send what is complete” or revise the selection.',
            )
          }
        } else if (code && DEFINITIVE_ERROR_CODES.has(code)) {
          persistRetry(null)
          setRetryUncertain(false)
          setPhase('reviewing')
          setError(
            'The selected materials could not be submitted. Review the selection and try again.',
          )
        } else {
          setRetryUncertain(true)
          setPhase('reviewing')
          setError('The result is uncertain. Check this same submission again before changing it.')
        }
      }
    })()
    mutationRef.current = mutation
    void mutation.finally(() => {
      if (mutationRef.current === mutation) mutationRef.current = null
    })
  }

  return (
    <div className="space-y-7">
      <IntakeProposalWorkspace
        key={`${ownerId}:${venueId}:${draftWorkspaceKey}`}
        ref={draftController}
        venueId={venueId}
        proposals={proposals}
        suspendEditing={phase !== 'editing'}
      />
      <IntakeV1ReviewPanel
        phase={phase}
        sources={review?.sources ?? []}
        selectedKeys={selectedKeys}
        partialAcknowledged={partialAcknowledged}
        receipt={receipt}
        loadingReceipt={loadingReceipt}
        error={error}
        retryUncertain={retryUncertain}
        moreSources={Boolean(sourceCursor)}
        moreUploads={Boolean(uploadCursor)}
        loadingMore={loadingMore}
        onPrepare={() => void prepare()}
        onToggle={retryUncertain ? () => undefined : toggleSelection}
        onPartialAcknowledged={(value) => {
          setPartialAcknowledged(value)
          renewOperation()
        }}
        onBack={() => {
          setReview(null)
          setPhase('editing')
          setError(null)
          setRetryUncertain(false)
          persistRetry(null)
        }}
        onSubmit={submit}
        onLoadMoreSources={() => void loadMore('source')}
        onLoadMoreUploads={() => void loadMore('upload')}
      />
      {receipt && processingTarget ? (
        <IntakeV1ProcessingStatus
          key={`${ownerId}:${venueId}:${processingTarget.submissionId}:${processingTarget.revision}`}
          ownerId={ownerId}
          venueId={venueId}
          submissionId={processingTarget.submissionId}
          revision={processingTarget.revision}
        />
      ) : null}
    </div>
  )
}
