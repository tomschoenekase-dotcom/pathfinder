'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import type { IntakeUploadMimeType } from '@pathfinder/contracts/intake-upload'

import { useTRPCClient } from '../lib/trpc'
import {
  identifyIntakeFile,
  intakeFileFingerprint,
  MAX_INTAKE_FILE_SELECTION,
  SAFE_INTAKE_FILE_TYPES,
  validateIntakeFile,
} from '../lib/intake-file-identity'

type SafeUpload = {
  id: string
  displayName: string
  fileName: string
  mimeType: string
  byteSize: number
  status: string
  rejectionCode?: string | null
}

export function IntakeFileUploadWorkspace({
  venueId,
  uploads,
}: {
  venueId: string
  uploads: SafeUpload[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  return (
    <IntakeFileUpload
      venueId={venueId}
      uploads={uploads}
      reserve={(input) =>
        client.intakeUpload.reserve.mutate({
          ...input,
          mimeType: input.mimeType as IntakeUploadMimeType,
        })
      }
      verify={(input) => client.intakeUpload.verify.mutate(input)}
      onCommitted={() => router.refresh()}
    />
  )
}

type ReserveResult = {
  upload: SafeUpload
  replayed: boolean
  nextAction: 'UPLOAD_BYTES' | 'REVIEW_STATUS'
  uploadRequest: { url: string; requiredHeaders: Record<string, string> } | null
}

type QueueItem = {
  localId: string
  file: File
  phase: 'selected' | 'hashing' | 'uploading' | 'verifying' | 'awaiting-review' | 'error'
  error: string | null
}

export function IntakeFileUpload({
  venueId,
  uploads,
  reserve,
  verify,
  onCommitted,
}: {
  venueId: string
  uploads: SafeUpload[]
  reserve: (input: {
    venueId: string
    requestId: string
    displayName: string
    fileName: string
    mimeType: string
    byteSize: number
    sha256: string
  }) => Promise<ReserveResult>
  verify: (input: { venueId: string; uploadId: string; claimId: string }) => Promise<{
    upload: SafeUpload
    retryable: boolean
    nextAction: string
  }>
  onCommitted?: () => void
}) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const identitiesRef = useRef(
    new Map<string, { fingerprint: string; requestId: string; claimId: string }>(),
  )
  const inFlightRef = useRef(new Set<string>())

  function update(localId: string, patch: Partial<QueueItem>) {
    setQueue((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    )
  }

  function selectFiles(files: FileList | null) {
    if (!files) return
    const selected = Array.from(files)
    if (queue.length + selected.length > MAX_INTAKE_FILE_SELECTION) {
      setSelectionError(`Choose at most ${MAX_INTAKE_FILE_SELECTION} files at a time.`)
      return
    }
    const next: QueueItem[] = []
    for (const file of selected) {
      const error = validateIntakeFile(file)
      next.push({
        localId: crypto.randomUUID(),
        file,
        phase: error ? 'error' : 'selected',
        error,
      })
    }
    setSelectionError(null)
    setQueue((current) => [...current, ...next])
  }

  async function upload(item: QueueItem) {
    if (inFlightRef.current.has(item.localId)) return
    inFlightRef.current.add(item.localId)
    try {
      update(item.localId, { phase: 'hashing', error: null })
      const identity = await identifyIntakeFile(item.file)
      const fingerprint = intakeFileFingerprint(item.file, identity)
      const prior = identitiesRef.current.get(item.localId)
      const attempt =
        prior?.fingerprint === fingerprint
          ? prior
          : { fingerprint, requestId: crypto.randomUUID(), claimId: crypto.randomUUID() }
      identitiesRef.current.set(item.localId, attempt)
      const reserved = await reserve({
        venueId,
        requestId: attempt.requestId,
        displayName: item.file.name,
        fileName: item.file.name,
        mimeType: item.file.type,
        byteSize: item.file.size,
        sha256: identity.sha256Hex,
      })
      if (reserved.upload.status === 'AWAITING_REVIEW') {
        update(item.localId, { phase: 'awaiting-review' })
        onCommitted?.()
        return
      }
      if (reserved.upload.status === 'REJECTED') {
        throw new Error('This upload was rejected. Remove it and select the file again.')
      }
      if (reserved.uploadRequest) {
        update(item.localId, { phase: 'uploading' })
        const response = await fetch(reserved.uploadRequest.url, {
          method: 'PUT',
          headers: reserved.uploadRequest.requiredHeaders,
          body: item.file,
        })
        // A lost successful PUT can replay as precondition-failed because the immutable object now
        // exists. Reconcile it through server-side generation/checksum verification; never infer
        // success from the storage response alone.
        if (!response.ok && response.status !== 412) {
          throw new Error(`Upload transport failed (${response.status}).`)
        }
      }
      update(item.localId, { phase: 'verifying' })
      const verified = await verify({
        venueId,
        uploadId: reserved.upload.id,
        claimId: attempt.claimId,
      })
      if (verified.upload.status !== 'AWAITING_REVIEW') {
        throw new Error(
          verified.upload.rejectionCode
            ? `Transport verification rejected this file (${verified.upload.rejectionCode}).`
            : 'Transport verification did not complete.',
        )
      }
      update(item.localId, { phase: 'awaiting-review' })
      onCommitted?.()
    } catch (error) {
      update(item.localId, {
        phase: 'error',
        error: error instanceof Error ? error.message : 'The file was not submitted.',
      })
    } finally {
      inFlightRef.current.delete(item.localId)
    }
  }

  return (
    <section
      className="rounded-2xl border border-pf-light bg-white p-5"
      aria-labelledby="file-intake-title"
    >
      <h2 id="file-intake-title" className="text-lg font-semibold text-pf-deep">
        Document and image intake
      </h2>
      <p className="mt-1 text-sm leading-6 text-pf-deep/75">
        Submit PDFs or supported raster images as quarantined evidence. A successful upload verifies
        only transport size, type, and checksum; it does not mean the format or file has passed
        malware inspection. Nothing here is published, approved, or applied.
      </p>
      <label className="mt-4 block text-sm font-medium text-pf-deep">
        Choose files
        <input
          className="mt-2 block min-h-11 w-full rounded-xl border border-pf-light p-2"
          type="file"
          multiple
          accept={SAFE_INTAKE_FILE_TYPES.join(',')}
          onChange={(event) => {
            selectFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
      </label>
      <p className="mt-1 text-xs text-pf-deep/65">
        PDF, JPEG, PNG, WebP, HEIC, HEIF, or TIFF. 25 MiB per file; up to 20 files.
      </p>
      {selectionError ? (
        <p className="mt-2 text-sm text-rose-700" role="alert">
          {selectionError}
        </p>
      ) : null}
      {queue.length > 0 ? (
        <ul className="mt-5 space-y-3" aria-label="Selected intake files">
          {queue.map((item) => (
            <li key={item.localId} className="rounded-xl border border-pf-light p-3">
              <p className="break-all text-sm font-medium text-pf-deep">{item.file.name}</p>
              <p className="text-xs text-pf-deep/65" aria-live="polite">
                {item.phase.replace('-', ' ')}
              </p>
              {item.error ? (
                <p className="mt-1 text-sm text-rose-700" role="alert">
                  {item.error}
                </p>
              ) : null}
              <div className="mt-2 flex gap-2">
                {item.phase !== 'awaiting-review' ? (
                  <button
                    className="rounded-full bg-pf-deep px-3 py-2 text-xs text-white disabled:opacity-60"
                    type="button"
                    disabled={
                      inFlightRef.current.has(item.localId) ||
                      ['hashing', 'uploading', 'verifying'].includes(item.phase)
                    }
                    onClick={() => void upload(item)}
                  >
                    {item.phase === 'error' ? 'Retry' : 'Upload'}
                  </button>
                ) : null}
                {!['hashing', 'uploading', 'verifying'].includes(item.phase) ? (
                  <button
                    className="rounded-full border border-pf-light px-3 py-2 text-xs text-pf-deep"
                    type="button"
                    onClick={() =>
                      setQueue((current) =>
                        current.filter((candidate) => candidate.localId !== item.localId),
                      )
                    }
                  >
                    Remove {item.file.name}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <h3 className="mt-6 font-medium text-pf-deep">Submitted evidence</h3>
      {uploads.length === 0 ? (
        <p className="mt-2 text-sm text-pf-deep/65">No quarantined files have been submitted.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {uploads.map((upload) => (
            <li key={upload.id} className="rounded-xl bg-slate-50 p-3 text-sm">
              <span className="font-medium">{upload.displayName}</span>
              <span className="ml-2 text-xs uppercase text-pf-deep/60">
                {upload.status.replaceAll('_', ' ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
