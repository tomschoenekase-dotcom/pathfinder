'use client'

import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  Pause,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from 'lucide-react'

import type {
  IntakeUploadCategory,
  IntakeUploadMimeType,
} from '@pathfinder/contracts/intake-upload'

import { useTRPCClient } from '../lib/trpc'
import { browserUuid } from '../lib/browser-uuid'
import {
  identifyIntakeFile,
  intakeFileFingerprint,
  MAX_INTAKE_FILE_SELECTION,
  SAFE_INTAKE_FILE_TYPES,
  validateIntakeFile,
} from '../lib/intake-file-identity'
import styles from './IntakeFileUpload.module.css'

type SafeUpload = {
  id: string
  displayName: string
  fileName: string
  mimeType: string
  byteSize: number
  category?: string
  status: string
  rejectionCode?: string | null
}

export function IntakeFileUploadWorkspace({
  venueId,
  uploads,
  categoryCounts,
  nextCursor,
}: {
  venueId: string
  uploads: SafeUpload[]
  categoryCounts?: Partial<Record<IntakeUploadCategory, number>> | undefined
  nextCursor?: { createdAt: string; id: string } | null | undefined
}) {
  const client = useTRPCClient()
  const router = useRouter()
  return (
    <IntakeFileUpload
      venueId={venueId}
      uploads={uploads}
      categoryCounts={categoryCounts}
      nextCursor={nextCursor}
      reserve={(input) =>
        client.intakeUpload.reserve.mutate({
          ...input,
          mimeType: input.mimeType as IntakeUploadMimeType,
        })
      }
      verify={(input) => client.intakeUpload.verify.mutate(input)}
      signMultipartPart={(input) => client.intakeUpload.signMultipartPart.mutate(input)}
      completeMultipart={(input) => client.intakeUpload.completeMultipart.mutate(input)}
      cancelMultipart={(input) => client.intakeUpload.cancelMultipart.mutate(input)}
      loadMore={(cursor) => client.intakeUpload.list.query({ venueId, cursor, limit: 50 })}
      onCommitted={() => router.refresh()}
    />
  )
}

type ReserveResult = {
  upload: SafeUpload
  replayed: boolean
  nextAction: 'UPLOAD_BYTES' | 'REVIEW_STATUS'
  uploadRequest:
    | { kind: 'single'; url: string; requiredHeaders: Record<string, string> }
    | {
        kind: 'multipart'
        partSize: number
        partCount: number
        completedParts: Array<{
          partNumber: number
          etag: string
          checksumSha256: string
          size: number
        }>
      }
    | null
}

type QueueItem = {
  localId: string
  file: File
  category: IntakeUploadCategory
  phase:
    | 'selected'
    | 'hashing'
    | 'uploading'
    | 'checking-format'
    | 'security-pending'
    | 'awaiting-review'
    | 'rejected'
    | 'invalid'
    | 'error'
  error: string | null
  remoteUploadId?: string
  uploadedBytes?: number
  multipart?: boolean
}

const CLIENT_PHASE_LABELS: Record<QueueItem['phase'], string> = {
  selected: 'Ready to send',
  hashing: 'Preparing file',
  uploading: 'Sending file',
  'checking-format': 'Checking file format',
  'security-pending': 'Security check pending',
  'awaiting-review': 'Checks complete — awaiting review',
  rejected: 'Could not be accepted',
  invalid: 'Cannot be added',
  error: 'Needs attention',
}

const BUSY_PHASES: QueueItem['phase'][] = ['hashing', 'uploading', 'checking-format']

const MATERIAL_CATEGORIES: Array<{
  value: IntakeUploadCategory
  label: string
  detail: string
}> = [
  { value: 'WEBSITE', label: 'Website', detail: 'Pages, exports, or screenshots' },
  { value: 'DOCUMENT', label: 'Documents and PDFs', detail: 'Policies, guides, and menus' },
  { value: 'PHOTO', label: 'Photos', detail: 'Venue and amenity photos' },
  { value: 'VIDEO_AUDIO', label: 'Videos or audio', detail: 'Tours, recordings, and clips' },
  { value: 'FLOOR_PLAN', label: 'Maps and floor plans', detail: 'Layouts and wayfinding' },
  { value: 'FAQ', label: 'Existing FAQs', detail: 'Common questions and answers' },
  { value: 'STAFF_INTERVIEW', label: 'Staff interview', detail: 'Recorded team knowledge' },
  { value: 'OTHER', label: 'Other', detail: 'Anything else that will help' },
]

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function QueueFilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  if (url) {
    return (
      <span
        className={styles.filePreview}
        style={{ backgroundImage: `url("${url}")` }}
        aria-hidden="true"
      />
    )
  }

  const Icon = file.type.startsWith('video/')
    ? Film
    : file.type.startsWith('audio/')
      ? Music2
      : file.type.startsWith('image/')
        ? ImageIcon
        : FileText
  return (
    <span className={styles.fileIcon} aria-hidden="true">
      <Icon />
    </span>
  )
}

function phaseIcon(phase: QueueItem['phase']) {
  if (phase === 'awaiting-review') return Check
  if (phase === 'security-pending') return ShieldCheck
  if (phase === 'error' || phase === 'rejected' || phase === 'invalid') return AlertTriangle
  if (BUSY_PHASES.includes(phase)) return LoaderCircle
  return UploadCloud
}

function inferredCategory(file: File): IntakeUploadCategory {
  if (file.type.startsWith('video/') || file.type.startsWith('audio/')) return 'VIDEO_AUDIO'
  if (file.type.startsWith('image/')) return 'PHOTO'
  if (file.type === 'application/pdf') return 'DOCUMENT'
  return 'OTHER'
}

function clientUploadStatus(status: string): string {
  switch (status) {
    case 'RESERVED':
      return 'Waiting to be sent'
    case 'VERIFYING':
      return 'Checking file format'
    case 'PRECHECK_PASSED':
      return 'Security check pending'
    case 'AWAITING_REVIEW':
      return 'Checks complete — awaiting review'
    case 'REJECTED':
      return 'Could not be accepted'
    default:
      return 'Status unavailable'
  }
}

class ClientIntakeFileError extends Error {}

export function IntakeFileUpload({
  venueId,
  uploads,
  categoryCounts,
  nextCursor = null,
  reserve,
  verify,
  signMultipartPart = async () => {
    throw new ClientIntakeFileError('Multipart upload is unavailable.')
  },
  completeMultipart = async () => {
    throw new ClientIntakeFileError('Multipart upload is unavailable.')
  },
  cancelMultipart = async () => {
    throw new ClientIntakeFileError('Multipart cancellation is unavailable.')
  },
  loadMore,
  onCommitted,
  initialQueue = [],
}: {
  venueId: string
  uploads: SafeUpload[]
  categoryCounts?: Partial<Record<IntakeUploadCategory, number>> | undefined
  nextCursor?: { createdAt: string; id: string } | null | undefined
  reserve: (input: {
    venueId: string
    requestId: string
    displayName: string
    fileName: string
    mimeType: string
    byteSize: number
    sha256: string
    category: IntakeUploadCategory
  }) => Promise<ReserveResult>
  verify: (input: { venueId: string; uploadId: string; claimId: string }) => Promise<{
    upload: SafeUpload
    retryable: boolean
    nextAction: string
  }>
  signMultipartPart?: (input: {
    venueId: string
    uploadId: string
    partNumber: number
    checksumSha256: string
  }) => Promise<{ url: string; requiredHeaders: Record<string, string> }>
  completeMultipart?: (input: { venueId: string; uploadId: string }) => Promise<unknown>
  cancelMultipart?: (input: { venueId: string; uploadId: string }) => Promise<unknown>
  loadMore?: (cursor: { createdAt: string; id: string }) => Promise<{
    items: SafeUpload[]
    nextCursor: { createdAt: string; id: string } | null
  }>
  onCommitted?: () => void
  /** Development fixtures and component tests only; production adapters intentionally omit this. */
  initialQueue?: QueueItem[]
}) {
  const fileInputId = useId()
  const [queueState, setQueueState] = useState<{ venueId: string; items: QueueItem[] }>({
    venueId,
    items: initialQueue,
  })
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [defaultCategory, setDefaultCategory] = useState<IntakeUploadCategory | 'AUTO'>('AUTO')
  const [visibleCategory, setVisibleCategory] = useState<IntakeUploadCategory | 'ALL' | null>(null)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [savedUploads, setSavedUploads] = useState(uploads)
  const [savedNextCursor, setSavedNextCursor] = useState(nextCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [savedChecks, setSavedChecks] = useState<Record<string, 'busy' | 'error'>>({})
  const identitiesRef = useRef(
    new Map<string, { fingerprint: string; requestId: string; claimId: string }>(),
  )
  const inFlightRef = useRef(new Set<string>())
  const abortControllersRef = useRef(new Map<string, AbortController>())
  const cancelRequestedRef = useRef(new Set<string>())
  const scopeRef = useRef(venueId)
  const generationRef = useRef(0)

  useEffect(() => {
    setSavedUploads(uploads)
    setSavedNextCursor(nextCursor)
  }, [uploads, nextCursor, venueId])

  if (scopeRef.current !== venueId) {
    scopeRef.current = venueId
    generationRef.current += 1
    identitiesRef.current.clear()
    inFlightRef.current.clear()
    for (const controller of abortControllersRef.current.values()) controller.abort()
    abortControllersRef.current.clear()
    cancelRequestedRef.current.clear()
  }

  const queue = queueState.venueId === venueId ? queueState.items : []
  const visibleSelectionError = queueState.venueId === venueId ? selectionError : null
  const visibleUploads =
    visibleCategory === null
      ? []
      : visibleCategory === 'ALL'
        ? savedUploads
        : savedUploads.filter((upload) => upload.category === visibleCategory)

  async function loadMoreUploads() {
    if (!loadMore || !savedNextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await loadMore(savedNextCursor)
      setSavedUploads((current) => {
        const known = new Set(current.map((upload) => upload.id))
        return [...current, ...page.items.filter((upload) => !known.has(upload.id))]
      })
      setSavedNextCursor(page.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }

  async function checkSavedUpload(saved: SafeUpload) {
    if (savedChecks[saved.id] === 'busy') return
    setSavedChecks((current) => ({ ...current, [saved.id]: 'busy' }))
    try {
      const result = await verify({
        venueId,
        uploadId: saved.id,
        claimId: browserUuid(),
      })
      setSavedUploads((current) =>
        current.map((upload) => (upload.id === saved.id ? result.upload : upload)),
      )
      setSavedChecks((current) => {
        const next = { ...current }
        delete next[saved.id]
        return next
      })
      onCommitted?.()
    } catch {
      setSavedChecks((current) => ({ ...current, [saved.id]: 'error' }))
    }
  }

  function update(
    localId: string,
    patch: Partial<QueueItem>,
    scope = venueId,
    generation = generationRef.current,
  ) {
    if (scopeRef.current !== scope || generationRef.current !== generation) return
    setQueueState((current) => ({
      venueId: scope,
      items:
        current.venueId === scope
          ? current.items.map((item) => (item.localId === localId ? { ...item, ...patch } : item))
          : [],
    }))
  }

  function selectFiles(files: FileList | null) {
    if (!files) return
    const selected = Array.from(files)
    if (queue.length + selected.length > MAX_INTAKE_FILE_SELECTION) {
      setSelectionError(`Choose at most ${MAX_INTAKE_FILE_SELECTION} files at a time.`)
      return
    }
    const next: QueueItem[] = []
    const knownFiles = new Set(
      queue.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`),
    )
    for (const file of selected) {
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}`
      const error = knownFiles.has(fingerprint)
        ? 'This file is already in your upload list.'
        : validateIntakeFile(file)
      knownFiles.add(fingerprint)
      next.push({
        localId: browserUuid(),
        file,
        category: defaultCategory === 'AUTO' ? inferredCategory(file) : defaultCategory,
        phase: error ? 'invalid' : 'selected',
        error,
      })
    }
    setSelectionError(null)
    setQueueState((current) => ({
      venueId,
      items: current.venueId === venueId ? [...current.items, ...next] : next,
    }))
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setDraggingFiles(false)
    selectFiles(event.dataTransfer.files)
  }

  async function uploadSelectedFiles() {
    for (const item of queue) {
      if (item.phase === 'selected') await upload(item)
    }
  }

  async function upload(item: QueueItem) {
    if (inFlightRef.current.has(item.localId)) return
    inFlightRef.current.add(item.localId)
    const submittedScope = venueId
    const generation = generationRef.current
    const isCurrent = () =>
      scopeRef.current === submittedScope && generationRef.current === generation
    const controller = new AbortController()
    abortControllersRef.current.set(item.localId, controller)
    try {
      update(item.localId, { phase: 'hashing', error: null }, submittedScope, generation)
      const identity = await identifyIntakeFile(item.file)
      if (!isCurrent()) return
      const fingerprint = intakeFileFingerprint(item.file, identity)
      const storageKey = `torchiko:intake-upload:v1:${submittedScope}:${identity.sha256Hex}:${item.file.size}`
      let persisted: { requestId: string; claimId: string } | null = null
      try {
        const raw = globalThis.localStorage?.getItem(storageKey)
        if (raw) persisted = JSON.parse(raw) as { requestId: string; claimId: string }
      } catch {
        persisted = null
      }
      const prior = identitiesRef.current.get(item.localId)
      const attempt =
        prior?.fingerprint === fingerprint
          ? prior
          : {
              fingerprint,
              requestId: persisted?.requestId ?? browserUuid(),
              claimId: persisted?.claimId ?? browserUuid(),
            }
      identitiesRef.current.set(item.localId, attempt)
      try {
        globalThis.localStorage?.setItem(
          storageKey,
          JSON.stringify({ requestId: attempt.requestId, claimId: attempt.claimId }),
        )
      } catch {
        // Resume remains available for this page even if browser storage is unavailable.
      }
      const reserved = await reserve({
        venueId: submittedScope,
        requestId: attempt.requestId,
        displayName: item.file.name,
        fileName: item.file.name,
        mimeType: item.file.type,
        byteSize: item.file.size,
        sha256: identity.sha256Hex,
        category: item.category,
      })
      if (!isCurrent()) return
      if (reserved.upload.status === 'AWAITING_REVIEW') {
        update(item.localId, { phase: 'awaiting-review' }, submittedScope, generation)
        onCommitted?.()
        return
      }
      if (reserved.upload.status === 'REJECTED') {
        identitiesRef.current.delete(item.localId)
        update(
          item.localId,
          {
            phase: 'rejected',
            error: 'This file could not be accepted. Remove it and select the file again.',
          },
          submittedScope,
          generation,
        )
        return
      }
      if (reserved.uploadRequest) {
        update(
          item.localId,
          {
            phase: 'uploading',
            remoteUploadId: reserved.upload.id,
            multipart: reserved.uploadRequest.kind === 'multipart',
          },
          submittedScope,
          generation,
        )
        if (reserved.uploadRequest.kind === 'single') {
          const response = await fetch(reserved.uploadRequest.url, {
            method: 'PUT',
            headers: reserved.uploadRequest.requiredHeaders,
            body: item.file,
            signal: controller.signal,
          })
          // A lost successful PUT can replay as precondition-failed because the immutable object now
          // exists. Reconcile it through server-side generation/checksum verification; never infer
          // success from the storage response alone.
          if (!response.ok && response.status !== 412) {
            throw new ClientIntakeFileError('The file could not be sent. Please try again.')
          }
        } else {
          const completed = new Set(
            reserved.uploadRequest.completedParts.map((part) => part.partNumber),
          )
          let uploadedBytes = reserved.uploadRequest.completedParts.reduce(
            (total, part) => total + part.size,
            0,
          )
          update(item.localId, { uploadedBytes }, submittedScope, generation)
          for (let partNumber = 1; partNumber <= reserved.uploadRequest.partCount; partNumber++) {
            if (completed.has(partNumber)) continue
            const start = (partNumber - 1) * reserved.uploadRequest.partSize
            const part = item.file.slice(
              start,
              Math.min(item.file.size, start + reserved.uploadRequest.partSize),
            )
            const digest = new Uint8Array(
              await crypto.subtle.digest('SHA-256', await part.arrayBuffer()),
            )
            const checksumSha256 = [...digest]
              .map((value) => value.toString(16).padStart(2, '0'))
              .join('')
            const signed = await signMultipartPart({
              venueId: submittedScope,
              uploadId: reserved.upload.id,
              partNumber,
              checksumSha256,
            })
            const response = await fetch(signed.url, {
              method: 'PUT',
              headers: signed.requiredHeaders,
              body: part,
              signal: controller.signal,
            })
            if (!response.ok)
              throw new ClientIntakeFileError(
                `Part ${partNumber} could not be sent. Retry to continue from saved parts.`,
              )
            uploadedBytes += part.size
            update(item.localId, { uploadedBytes }, submittedScope, generation)
          }
          await completeMultipart({ venueId: submittedScope, uploadId: reserved.upload.id })
        }
        if (!isCurrent()) return
      }
      update(item.localId, { phase: 'checking-format' }, submittedScope, generation)
      const verified = await verify({
        venueId: submittedScope,
        uploadId: reserved.upload.id,
        claimId: attempt.claimId,
      })
      if (!isCurrent()) return
      if (verified.upload.status === 'AWAITING_REVIEW') {
        update(item.localId, { phase: 'awaiting-review' }, submittedScope, generation)
        onCommitted?.()
        return
      }
      if (verified.upload.status === 'PRECHECK_PASSED') {
        update(item.localId, { phase: 'security-pending', error: null }, submittedScope, generation)
        onCommitted?.()
        return
      }
      if (verified.upload.status === 'REJECTED' || verified.nextAction === 'RESELECT_FILE') {
        identitiesRef.current.delete(item.localId)
        update(
          item.localId,
          {
            phase: 'rejected',
            error: 'Torchiko could not accept this file. Remove it and select the file again.',
          },
          submittedScope,
          generation,
        )
        onCommitted?.()
        return
      }
      throw new ClientIntakeFileError(
        'Torchiko could not confirm the latest check. Please try again.',
      )
    } catch (error) {
      if (isCurrent()) {
        update(
          item.localId,
          {
            phase: 'error',
            error: cancelRequestedRef.current.has(item.localId)
              ? 'Upload cancelled.'
              : error instanceof DOMException && error.name === 'AbortError'
                ? 'Upload paused. Retry to continue from the saved parts.'
                : error instanceof ClientIntakeFileError
                  ? error.message
                  : 'Torchiko could not confirm this file. Please try again.',
          },
          submittedScope,
          generation,
        )
      }
    } finally {
      inFlightRef.current.delete(item.localId)
      abortControllersRef.current.delete(item.localId)
      cancelRequestedRef.current.delete(item.localId)
    }
  }

  async function cancelUpload(item: QueueItem) {
    cancelRequestedRef.current.add(item.localId)
    abortControllersRef.current.get(item.localId)?.abort()
    if (!item.remoteUploadId || !item.multipart) return
    try {
      await cancelMultipart({ venueId, uploadId: item.remoteUploadId })
      identitiesRef.current.delete(item.localId)
      update(item.localId, { phase: 'rejected', error: 'Upload cancelled.' })
      onCommitted?.()
    } catch {
      update(item.localId, {
        phase: 'error',
        error: 'Torchiko could not confirm cancellation. Retry or check the saved file status.',
      })
    }
  }

  const selectedCount = queue.filter((item) => item.phase === 'selected').length
  const handoffState = queue.some((item) => BUSY_PHASES.includes(item.phase))
    ? 'sending'
    : queue.some((item) => ['security-pending', 'awaiting-review'].includes(item.phase))
      ? 'joined'
      : selectedCount > 0
        ? 'queued'
        : 'idle'
  const queueHasRecoverableError = queue.some((item) =>
    ['error', 'invalid', 'rejected'].includes(item.phase),
  )
  const queueHeading =
    handoffState === 'sending'
      ? {
          title: 'Sending to Torchiko',
          summary: 'You can keep this page open while the active file finishes.',
        }
      : selectedCount > 0
        ? {
            title: 'Ready to share',
            summary: 'Check the type if you want, then send the files. Nothing is published here.',
          }
        : queueHasRecoverableError
          ? {
              title: 'A file needs attention',
              summary: 'Retry a paused handoff or remove a file that cannot be accepted.',
            }
          : {
              title: 'Handoff complete',
              summary: 'Torchiko has the file and will keep the next checks visible here.',
            }

  return (
    <section className={styles.workbench} aria-labelledby="file-intake-title">
      <div className={styles.workbenchHeader}>
        <div>
          <p className={styles.eyebrow}>Give us what you have</p>
          <h2 id="file-intake-title">Share venue materials</h2>
          <p>
            Photos, videos, documents, maps, or rough notes are all useful. Torchiko will organize
            them after the file checks finish. Nothing is published from this page.
          </p>
        </div>
        <label className={styles.sortControl}>
          Sort new files as
          <select
            value={defaultCategory}
            onChange={(event) =>
              setDefaultCategory(event.currentTarget.value as IntakeUploadCategory | 'AUTO')
            }
          >
            <option value="AUTO">Choose automatically</option>
            {MATERIAL_CATEGORIES.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label
        className={`${styles.dropField} ${draggingFiles ? styles.dropFieldActive : ''}`}
        data-activity={handoffState}
        htmlFor={fileInputId}
        onDragEnter={(event) => {
          event.preventDefault()
          setDraggingFiles(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDraggingFiles(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDraggingFiles(false)
          }
        }}
        onDrop={handleDrop}
      >
        <input
          id={fileInputId}
          className={styles.fileInput}
          aria-label="Choose files"
          type="file"
          multiple
          accept={SAFE_INTAKE_FILE_TYPES.join(',')}
          onChange={(event) => {
            selectFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
        <span className={styles.dropIcon} aria-hidden="true">
          <UploadCloud />
        </span>
        <span className={styles.dropCopy}>
          <strong>
            {draggingFiles ? 'Release to add these files' : 'Drop files into Torchiko'}
          </strong>
          <span>or browse this device</span>
        </span>
        <span className={styles.browseAction}>
          <FolderOpen aria-hidden="true" /> Browse
        </span>
      </label>
      <p className={styles.limits}>
        PDF, common image, video, and audio formats · 20 files at once · 2 GB per media file · 50 GB
        total for this venue
      </p>
      {visibleSelectionError ? (
        <p className={styles.inlineError} role="alert">
          <AlertTriangle aria-hidden="true" /> {visibleSelectionError}
        </p>
      ) : null}

      {queue.length > 0 ? (
        <div className={styles.queueSection}>
          <div className={styles.queueHeading}>
            <div>
              <h3>{queueHeading.title}</h3>
              <p>{queueHeading.summary}</p>
            </div>
            {selectedCount > 1 ? (
              <button
                className={styles.primaryButton}
                type="button"
                onClick={() => void uploadSelectedFiles()}
              >
                Send {selectedCount} files
              </button>
            ) : null}
          </div>
          <ul className={styles.queue} aria-label="Selected intake files">
            {queue.map((item) => {
              const PhaseIcon = phaseIcon(item.phase)
              const progress =
                item.phase === 'uploading' && item.uploadedBytes !== undefined
                  ? Math.min(100, Math.round((item.uploadedBytes / item.file.size) * 100))
                  : null
              return (
                <li key={item.localId} className={styles.queueItem} data-phase={item.phase}>
                  <QueueFilePreview file={item.file} />
                  <div className={styles.fileDetails}>
                    <div className={styles.fileTitleRow}>
                      <p title={item.file.name}>{item.file.name}</p>
                      <span>{formatBytes(item.file.size)}</span>
                    </div>
                    <div className={styles.fileState} role="status" aria-live="polite">
                      <PhaseIcon
                        className={BUSY_PHASES.includes(item.phase) ? styles.spinning : undefined}
                        aria-hidden="true"
                      />
                      {CLIENT_PHASE_LABELS[item.phase]}
                      {progress !== null ? ` · ${progress}%` : ''}
                    </div>
                    {progress !== null ? (
                      <div
                        className={styles.progressTrack}
                        role="progressbar"
                        aria-label={`Uploading ${item.file.name}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                      >
                        <span style={{ width: `${progress}%` }} />
                      </div>
                    ) : null}
                    <label className={styles.fileCategory}>
                      Type
                      <select
                        value={item.category}
                        disabled={item.phase !== 'selected'}
                        onChange={(event) =>
                          update(item.localId, {
                            category: event.currentTarget.value as IntakeUploadCategory,
                          })
                        }
                      >
                        {MATERIAL_CATEGORIES.map((category) => (
                          <option key={category.value} value={category.value}>
                            {category.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {item.error ? (
                      <p className={styles.fileError} role="alert">
                        {item.error}
                      </p>
                    ) : null}
                  </div>
                  <div className={styles.fileActions}>
                    {['selected', 'error', 'security-pending'].includes(item.phase) ? (
                      <button
                        className={styles.primaryButton}
                        type="button"
                        disabled={
                          inFlightRef.current.has(item.localId) || BUSY_PHASES.includes(item.phase)
                        }
                        onClick={() => void upload(item)}
                      >
                        {item.phase === 'error' ? (
                          <RefreshCw aria-hidden="true" />
                        ) : item.phase === 'security-pending' ? (
                          <ShieldCheck aria-hidden="true" />
                        ) : (
                          <UploadCloud aria-hidden="true" />
                        )}
                        {item.phase === 'error'
                          ? 'Retry'
                          : item.phase === 'security-pending'
                            ? 'Check status'
                            : 'Upload'}
                      </button>
                    ) : null}
                    {item.phase === 'uploading' ? (
                      <button
                        className={styles.quietButton}
                        type="button"
                        onClick={() => void cancelUpload(item)}
                      >
                        <Pause aria-hidden="true" />
                        {item.multipart ? 'Cancel upload' : 'Pause upload'}
                      </button>
                    ) : null}
                    {!BUSY_PHASES.includes(item.phase) ? (
                      <button
                        className={styles.iconButton}
                        type="button"
                        aria-label={
                          ['security-pending', 'awaiting-review'].includes(item.phase)
                            ? `Dismiss ${item.file.name}`
                            : `Remove ${item.file.name}`
                        }
                        onClick={() =>
                          setQueueState((current) => ({
                            venueId,
                            items:
                              current.venueId === venueId
                                ? current.items.filter(
                                    (candidate) => candidate.localId !== item.localId,
                                  )
                                : [],
                          }))
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      <div className={styles.librarySection}>
        <div className={styles.libraryHeading}>
          <div>
            <p className={styles.eyebrow}>Already shared</p>
            <h3>Material library</h3>
          </div>
          <p>
            {savedUploads.length} file{savedUploads.length === 1 ? '' : 's'} in Torchiko
          </p>
        </div>
        <div className={styles.categoryGrid} aria-label="Filter shared files by material type">
          {MATERIAL_CATEGORIES.map((category) => {
            const count =
              categoryCounts?.[category.value] ??
              savedUploads.filter((upload) => upload.category === category.value).length
            const selected = visibleCategory === category.value
            return (
              <button
                key={category.value}
                type="button"
                aria-label={`${category.label} ${count}`}
                aria-pressed={selected}
                className={selected ? styles.categorySelected : undefined}
                onClick={() => setVisibleCategory(selected ? null : category.value)}
              >
                <span>
                  <strong>{category.label}</strong>
                  <small>{category.detail}</small>
                </span>
                <b>{count}</b>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className={styles.savedHeading}
          aria-expanded={visibleCategory !== null}
          onClick={() => setVisibleCategory(visibleCategory === null ? 'ALL' : null)}
        >
          <span>
            {visibleCategory && visibleCategory !== 'ALL'
              ? MATERIAL_CATEGORIES.find((category) => category.value === visibleCategory)?.label
              : 'All shared files'}
          </span>
          <ChevronDown aria-hidden="true" />
        </button>
        {visibleCategory !== null ? (
          visibleUploads.length === 0 ? (
            <p className={styles.emptyLibrary}>
              Nothing in this category yet. Add it whenever it is ready.
            </p>
          ) : (
            <ul className={styles.savedFiles}>
              {visibleUploads.map((upload) => (
                <li key={upload.id}>
                  <span className={styles.savedFileMark} aria-hidden="true">
                    <FileText />
                  </span>
                  <span>
                    <strong>{upload.displayName}</strong>
                    <small>
                      {formatBytes(upload.byteSize)} · {clientUploadStatus(upload.status)}
                    </small>
                  </span>
                  {upload.status === 'PRECHECK_PASSED' || upload.status === 'VERIFYING' ? (
                    <button
                      type="button"
                      disabled={savedChecks[upload.id] === 'busy'}
                      onClick={() => void checkSavedUpload(upload)}
                      className={styles.quietButton}
                    >
                      {upload.status === 'VERIFYING' ? (
                        <RefreshCw aria-hidden="true" />
                      ) : (
                        <ShieldCheck aria-hidden="true" />
                      )}
                      {savedChecks[upload.id] === 'busy'
                        ? 'Checking…'
                        : upload.status === 'VERIFYING'
                          ? 'Retry file check'
                          : 'Complete security check'}
                    </button>
                  ) : (
                    <span className={styles.savedStatus}>
                      {upload.status === 'AWAITING_REVIEW' ? <Check aria-hidden="true" /> : null}
                      {clientUploadStatus(upload.status)}
                    </span>
                  )}
                  {savedChecks[upload.id] === 'error' ? (
                    <p className={styles.fileError} role="alert">
                      {upload.status === 'VERIFYING'
                        ? 'Torchiko could not confirm the file check. Try again.'
                        : 'Security verification is unavailable. Try this check again.'}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
        {visibleCategory !== null && savedNextCursor && loadMore ? (
          <button
            type="button"
            disabled={loadingMore}
            className={styles.loadMore}
            onClick={() => void loadMoreUploads()}
          >
            {loadingMore ? 'Loading more…' : 'Load more files'}
          </button>
        ) : null}
      </div>
    </section>
  )
}
