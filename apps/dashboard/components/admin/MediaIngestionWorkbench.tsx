'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

import { useTRPCClient } from '../../lib/trpc'
import { planMediaUploadResume } from '../../lib/media-upload-resume'
import { putBlobWithDeadline, UploadDeadlineError } from '../../lib/bounded-upload'
import {
  fingerprintMediaSource,
  MAX_MEDIA_SOURCE_BYTES,
  MEDIA_SOURCE_FINGERPRINT_ALGORITHM,
  type MediaSourceIdentity,
} from '../../lib/media-source-identity'

type Mode = 'ECONOMY' | 'BALANCED' | 'FORENSIC'
type Project = {
  id: string
  name: string
  mode: Mode
  status: string
  stage: string
  progress: number
  sourceFileName: string | null
  sourceBytes: number | null
  sourceLastModified: number | null
  sourceFingerprintAlgorithm: string | null
  uploadAttemptId: string | null
  actualCostCents: number
  estimatedCostCents: number | null
  createdAt: Date
}

const modeCopy: Record<Mode, { label: string; detail: string }> = {
  ECONOMY: {
    label: 'Economy',
    detail: 'Deduplicate first and inspect representative video frames. Best for a first pass.',
  },
  BALANCED: {
    label: 'Balanced',
    detail: 'Read every photo, transcribe narration, and sample video scenes adaptively.',
  },
  FORENSIC: {
    label: 'Forensic',
    detail:
      'Maximum label transcription, denser video coverage, and stricter uncertainty tracking.',
  },
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return 'No archive yet'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function throwIfTransferAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Media transfer was cancelled.', 'AbortError')
}

export function MediaIngestionWorkbench({
  tenantId,
  venueId,
  venueName,
  initialProjects,
}: {
  tenantId: string
  venueId: string
  venueName: string
  initialProjects: Project[]
}) {
  const router = useRouter()
  const client = useTRPCClient()

  const [name, setName] = useState(`${venueName} media intake`)
  const [context, setContext] = useState('')
  const [mode, setMode] = useState<Mode>('BALANCED')
  const [transcribeAudio, setTranscribeAudio] = useState(true)
  const [preserveVerbatimText, setPreserveVerbatimText] = useState(true)
  const [detectDuplicates, setDetectDuplicates] = useState(true)
  const [requireEveryImage, setRequireEveryImage] = useState(true)
  const [videoSecondsPerSample, setVideoSecondsPerSample] = useState(8)
  const [useGeminiVideoUnderstanding, setUseGeminiVideoUnderstanding] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [transferPhase, setTransferPhase] = useState<'hashing' | 'uploading' | 'finalizing'>(
    'uploading',
  )
  const [error, setError] = useState<string | null>(null)
  const [resumingProjectId, setResumingProjectId] = useState<string | null>(null)
  const [reconcilingProjectId, setReconcilingProjectId] = useState<string | null>(null)
  const [abortingProjectId, setAbortingProjectId] = useState<string | null>(null)
  const [retryingProjectId, setRetryingProjectId] = useState<string | null>(null)
  const activeTransfer = useRef<AbortController | null>(null)

  useEffect(() => () => activeTransfer.current?.abort(), [])

  async function fingerprintArchive(archive: File, signal: AbortSignal) {
    setTransferPhase('hashing')
    setUploadProgress(0)
    return fingerprintMediaSource(archive, {
      signal,
      onProgress: (processed, total) =>
        setUploadProgress(total === 0 ? 100 : Math.round((processed / total) * 100)),
    })
  }

  async function uploadArchive(
    projectId: string,
    archive: File,
    options: {
      uploadAttemptId?: string
      sourceIdentity?: MediaSourceIdentity
      signal: AbortSignal
    },
  ) {
    const uploadAttemptId = options.uploadAttemptId ?? crypto.randomUUID()
    setTransferPhase('uploading')
    setUploadProgress(0)
    throwIfTransferAborted(options.signal)
    const contentType =
      archive.type === 'application/x-zip-compressed'
        ? 'application/x-zip-compressed'
        : 'application/zip'
    const started = await client.mediaIngestion.beginUpload.mutate({
      tenantId,
      projectId,
      uploadAttemptId,
      filename: archive.name,
      bytes: archive.size,
      lastModified: archive.lastModified,
      sourceIdentity: options.sourceIdentity,
      contentType,
    })
    const partCount = Math.ceil(archive.size / started.partSize)
    const plan = planMediaUploadResume(partCount, started.parts)
    const parts = [...plan.parts]
    const remainingPartNumbers = plan.remainingPartNumbers
    let uploadedBytes = plan.uploadedBytes
    let nextPartIndex = 0
    setUploadProgress(Math.round((uploadedBytes / archive.size) * 100))

    async function worker() {
      while (nextPartIndex < remainingPartNumbers.length) {
        throwIfTransferAborted(options.signal)
        const partNumber = remainingPartNumbers[nextPartIndex++]
        if (partNumber === undefined) return
        const start = (partNumber - 1) * started.partSize
        const body = archive.slice(start, Math.min(start + started.partSize, archive.size))
        const { url } = await client.mediaIngestion.signPart.mutate({
          tenantId,
          projectId,
          uploadAttemptId,
          partNumber,
        })
        throwIfTransferAborted(options.signal)
        const response = await putBlobWithDeadline({
          url,
          body,
          signal: options.signal,
          timeoutMs: 10 * 60 * 1000,
        }).catch((error) => {
          if (error instanceof UploadDeadlineError) {
            throw new Error(
              `Upload part ${partNumber} timed out. Retry to continue from completed parts.`,
            )
          }
          throw error
        })
        if (!response.ok) throw new Error(`Upload part ${partNumber} failed (${response.status}).`)
        const etag = response.headers.get('etag')
        if (!etag) throw new Error('Storage CORS must expose the ETag response header.')
        parts.push({ partNumber, etag })
        uploadedBytes += body.size
        setUploadProgress(Math.round((uploadedBytes / archive.size) * 100))
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(3, remainingPartNumbers.length) }, () => worker()),
    )
    parts.sort((a, b) => a.partNumber - b.partNumber)
    throwIfTransferAborted(options.signal)
    setTransferPhase('finalizing')
    await client.mediaIngestion.completeUpload.mutate({
      tenantId,
      projectId,
      uploadAttemptId,
      parts,
    })
  }

  async function resumeUpload(project: Project, archive: File) {
    if (
      !project.uploadAttemptId ||
      project.sourceFileName === null ||
      project.sourceBytes === null ||
      project.sourceLastModified === null
    ) {
      setError('This upload does not have a resumable source identity. Abort it and start again.')
      return
    }
    if (
      archive.name !== project.sourceFileName ||
      archive.size !== project.sourceBytes ||
      archive.lastModified !== project.sourceLastModified
    ) {
      setError(
        `Choose the original ${project.sourceFileName} file (${formatBytes(project.sourceBytes)}).`,
      )
      return
    }

    setResumingProjectId(project.id)
    setError(null)
    setUploadProgress(0)
    const controller = new AbortController()
    activeTransfer.current = controller
    try {
      let sourceIdentity: MediaSourceIdentity | undefined
      if (project.sourceFingerprintAlgorithm === MEDIA_SOURCE_FINGERPRINT_ALGORITHM) {
        sourceIdentity = await fingerprintArchive(archive, controller.signal)
      } else if (project.sourceFingerprintAlgorithm !== null) {
        throw new Error(
          'This upload uses an unsupported source identity. Abort it and start again.',
        )
      }
      await uploadArchive(project.id, archive, {
        uploadAttemptId: project.uploadAttemptId,
        ...(sourceIdentity ? { sourceIdentity } : {}),
        signal: controller.signal,
      })
      router.refresh()
    } catch (resumeError) {
      setError(errorMessage(resumeError))
      router.refresh()
    } finally {
      if (activeTransfer.current === controller) activeTransfer.current = null
      setResumingProjectId(null)
    }
  }

  async function abortUpload(project: Project) {
    if (!project.uploadAttemptId) return
    setAbortingProjectId(project.id)
    setError(null)
    try {
      await client.mediaIngestion.abortUpload.mutate({
        tenantId,
        projectId: project.id,
        uploadAttemptId: project.uploadAttemptId,
      })
      router.refresh()
    } catch (abortError) {
      setError(errorMessage(abortError))
    } finally {
      setAbortingProjectId(null)
    }
  }

  async function reconcileUpload(project: Project) {
    if (!project.uploadAttemptId) return
    setReconcilingProjectId(project.id)
    setError(null)
    try {
      await client.mediaIngestion.reconcileUpload.mutate({
        tenantId,
        projectId: project.id,
        uploadAttemptId: project.uploadAttemptId,
      })
      router.refresh()
    } catch (reconcileError) {
      setError(errorMessage(reconcileError))
      router.refresh()
    } finally {
      setReconcilingProjectId(null)
    }
  }

  async function retryEnqueue(project: Project) {
    if (!project.uploadAttemptId) return
    setRetryingProjectId(project.id)
    setError(null)
    try {
      await client.mediaIngestion.retryEnqueue.mutate({
        tenantId,
        projectId: project.id,
        uploadAttemptId: project.uploadAttemptId,
      })
      router.refresh()
    } catch (enqueueError) {
      setError(errorMessage(enqueueError))
    } finally {
      setRetryingProjectId(null)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!file) {
      setError('Choose a ZIP archive first.')
      return
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('The source archive must be a .zip file.')
      return
    }
    if (file.size <= 0 || file.size > MAX_MEDIA_SOURCE_BYTES) {
      setError('The source archive must be between 1 byte and 5 GB.')
      return
    }

    setBusy(true)
    setError(null)
    setUploadProgress(0)
    const controller = new AbortController()
    activeTransfer.current = controller
    try {
      const sourceIdentity = await fingerprintArchive(file, controller.signal)
      throwIfTransferAborted(controller.signal)
      const project = await client.mediaIngestion.create.mutate({
        tenantId,
        venueId,
        name,
        context,
        mode,
        settings: {
          transcribeAudio,
          preserveVerbatimText,
          detectDuplicates,
          requireEveryImage,
          videoSecondsPerSample,
          useGeminiVideoUnderstanding,
        },
      })
      throwIfTransferAborted(controller.signal)
      await uploadArchive(project.id, file, { sourceIdentity, signal: controller.signal })
      router.refresh()
      setFile(null)
    } catch (caught) {
      setError(errorMessage(caught))
      router.refresh()
    } finally {
      if (activeTransfer.current === controller) activeTransfer.current = null
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={(event) => void submit(event)} className="space-y-6">
        <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
                New intake
              </p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-pf-deep">
                Drop the whole visit here
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/60">
                Photos, videos, audio, manifests, prior spreadsheets, and notes can live in one ZIP.
                Processing keeps source-level evidence and stops for your answers only when
                ambiguity affects the final venue guide.
              </p>
            </div>
            <span className="rounded-full bg-pf-primary/10 px-3 py-1 text-xs font-semibold text-pf-primary">
              Admin only
            </span>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <label className="text-sm font-medium text-pf-deep/70">
              Project name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={160}
                className="mt-2 min-h-11 w-full rounded-lg border border-pf-light bg-pf-surface px-4 outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
              />
            </label>
            <label className="text-sm font-medium text-pf-deep/70">
              Source ZIP (up to 5 GB)
              <input
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="mt-2 block min-h-11 w-full rounded-lg border border-pf-light bg-pf-surface px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="mt-5 block text-sm font-medium text-pf-deep/70">
            Context and instructions
            <textarea
              value={context}
              onChange={(event) => setContext(event.target.value)}
              maxLength={30_000}
              rows={7}
              placeholder="What venue is this? What did you photograph? Paste prior handoff notes, naming rules, known gaps, or anything the system should treat as context rather than visual evidence."
              className="mt-2 w-full rounded-lg border border-pf-light bg-pf-surface px-4 py-3 text-sm leading-6 outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
            />
          </label>
        </section>

        <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-pf-deep">Cost and coverage</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {(Object.keys(modeCopy) as Mode[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`rounded-xl border p-4 text-left transition ${mode === value ? 'border-pf-accent bg-pf-accent/5 ring-2 ring-pf-accent/15' : 'border-pf-light hover:border-pf-accent/50'}`}
              >
                <span className="font-semibold text-pf-deep">{modeCopy[value].label}</span>
                <span className="mt-1 block text-xs leading-5 text-pf-deep/55">
                  {modeCopy[value].detail}
                </span>
              </button>
            ))}
          </div>
          <label className="mt-5 flex items-start gap-3 border-t border-pf-light pt-5 text-sm text-pf-deep/70">
            <input
              type="checkbox"
              checked={useGeminiVideoUnderstanding}
              onChange={(event) => setUseGeminiVideoUnderstanding(event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-pf-accent"
            />
            <span>
              <span className="block font-semibold text-pf-deep">
                Analyze complete videos with Google Gemini
              </span>
              <span className="mt-1 block leading-6">
                Sends each client video, its filename, and up to 12,000 characters of this
                project&apos;s operator context to Google so Torchiko can connect motion, narration,
                visible text, and timestamped events. Torchiko requests deletion immediately after
                analysis; Google API logs may still follow the project&apos;s configured retention
                policy. If this path is unavailable, Torchiko falls back to bounded frame sampling
                and records that limitation for review.
              </span>
            </span>
          </label>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {[
              ['Transcribe narration and video audio', transcribeAudio, setTranscribeAudio],
              ['Preserve label text verbatim', preserveVerbatimText, setPreserveVerbatimText],
              ['Detect revisits and duplicate objects', detectDuplicates, setDetectDuplicates],
              ['Account for every image', requireEveryImage, setRequireEveryImage],
            ].map(([label, checked, setter]) => (
              <label
                key={String(label)}
                className="flex items-center gap-3 rounded-lg bg-pf-surface px-4 py-3 text-sm text-pf-deep/75"
              >
                <input
                  type="checkbox"
                  checked={checked as boolean}
                  onChange={(event) => (setter as (value: boolean) => void)(event.target.checked)}
                  className="h-4 w-4 accent-pf-accent"
                />
                {label as string}
              </label>
            ))}
          </div>

          <label className="mt-5 block text-sm font-medium text-pf-deep/70">
            Base video sample interval: {videoSecondsPerSample} seconds
            <input
              type="range"
              min={2}
              max={30}
              value={videoSecondsPerSample}
              onChange={(event) => setVideoSecondsPerSample(Number(event.target.value))}
              className="mt-2 block w-full accent-pf-accent"
            />
            <span className="mt-1 block text-xs font-normal text-pf-deep/50">
              Shorter intervals catch more motion and labels; a 120-frame cap per video protects
              spend.
            </span>
          </label>
        </section>

        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-4">
          {busy ? (
            <span className="text-sm text-pf-deep/60">
              {transferPhase === 'hashing'
                ? 'Checking source'
                : transferPhase === 'finalizing'
                  ? 'Finalizing'
                  : 'Uploading'}{' '}
              {uploadProgress}%
            </span>
          ) : null}
          {busy && transferPhase !== 'finalizing' ? (
            <button
              type="button"
              onClick={() => activeTransfer.current?.abort()}
              className="text-sm font-semibold text-pf-primary hover:text-pf-accent"
            >
              Cancel transfer
            </button>
          ) : null}
          <button
            type="submit"
            disabled={
              busy || resumingProjectId !== null || reconcilingProjectId !== null || !name.trim()
            }
            className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-6 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Creating intake…' : 'Upload and analyze'}
          </button>
        </div>
      </form>

      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Previous intakes</h2>
          <span className="text-sm text-pf-deep/50">{initialProjects.length} total</span>
        </div>
        {initialProjects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60">
            No media intakes for this venue yet.
          </div>
        ) : (
          <div className="grid gap-3">
            {initialProjects.map((project) => (
              <div
                key={project.id}
                className="rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="font-semibold text-pf-deep">{project.name}</h3>
                    <p className="mt-1 text-xs text-pf-deep/50">
                      {project.mode.toLowerCase()} · {formatBytes(project.sourceBytes)} ·{' '}
                      {project.sourceFileName ?? 'waiting for upload'}
                    </p>
                  </div>
                  <span className="rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-semibold text-pf-deep/65">
                    {project.status.replace(/_/g, ' ').toLowerCase()}
                  </span>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-pf-light/60">
                  <div className="h-full bg-pf-accent" style={{ width: `${project.progress}%` }} />
                </div>
                <p className="mt-2 text-xs text-pf-deep/50">
                  Stage: {project.stage.replace(/_/g, ' ')} · {project.progress}%
                </p>
                <Link
                  href={`/admin/clients/${tenantId}/venues/${venueId}/media/${project.id}`}
                  className="mt-3 inline-flex text-sm font-semibold text-pf-primary hover:text-pf-accent"
                >
                  Open intake →
                </Link>
                {project.status === 'UPLOADING' &&
                project.stage === 'upload' &&
                project.uploadAttemptId ? (
                  resumingProjectId === project.id ? (
                    <span className="ml-4 mt-3 inline-flex text-sm font-semibold text-pf-primary">
                      {transferPhase === 'hashing'
                        ? 'Checking source'
                        : transferPhase === 'finalizing'
                          ? 'Finalizing'
                          : 'Resuming'}{' '}
                      {uploadProgress}%
                      {transferPhase !== 'finalizing' ? (
                        <button
                          type="button"
                          onClick={() => activeTransfer.current?.abort()}
                          className="ml-3 text-pf-accent hover:text-pf-primary"
                        >
                          Cancel
                        </button>
                      ) : null}
                    </span>
                  ) : (
                    <label className="ml-4 mt-3 inline-flex cursor-pointer text-sm font-semibold text-pf-primary hover:text-pf-accent">
                      Resume upload
                      <input
                        type="file"
                        accept=".zip,application/zip,application/x-zip-compressed"
                        disabled={busy || resumingProjectId !== null}
                        className="sr-only"
                        onChange={(event) => {
                          const archive = event.target.files?.[0]
                          event.target.value = ''
                          if (archive) void resumeUpload(project, archive)
                        }}
                      />
                    </label>
                  )
                ) : null}
                {project.status === 'UPLOADING' &&
                project.stage === 'finalizing' &&
                project.uploadAttemptId ? (
                  <button
                    type="button"
                    disabled={reconcilingProjectId === project.id}
                    onClick={() => void reconcileUpload(project)}
                    className="ml-4 mt-3 inline-flex text-sm font-semibold text-pf-primary hover:text-pf-accent disabled:opacity-50"
                  >
                    {reconcilingProjectId === project.id
                      ? 'Checking finalization…'
                      : 'Retry finalization'}
                  </button>
                ) : null}
                {project.status === 'UPLOADING' &&
                (project.stage === 'upload' || project.stage === 'aborting') &&
                project.uploadAttemptId ? (
                  <button
                    type="button"
                    disabled={abortingProjectId === project.id || resumingProjectId === project.id}
                    onClick={() => void abortUpload(project)}
                    className="ml-4 mt-3 inline-flex text-sm font-semibold text-rose-700 hover:text-rose-900 disabled:opacity-50"
                  >
                    {abortingProjectId === project.id ? 'Aborting…' : 'Abort upload'}
                  </button>
                ) : null}
                {project.status === 'QUEUED' &&
                project.stage === 'inventory' &&
                project.uploadAttemptId ? (
                  <button
                    type="button"
                    disabled={retryingProjectId === project.id}
                    onClick={() => void retryEnqueue(project)}
                    className="ml-4 mt-3 inline-flex text-sm font-semibold text-amber-700 hover:text-amber-900 disabled:opacity-50"
                  >
                    {retryingProjectId === project.id ? 'Retrying…' : 'Retry enqueue'}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
